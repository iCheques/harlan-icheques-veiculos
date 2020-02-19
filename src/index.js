/* eslint-disable no-undef */
import 'core-js/stable';
import 'regenerator-runtime/runtime';

import $ from 'jquery';
import harlan from 'harlan';
import { CPF, CNPJ } from 'cpf_cnpj';
import moment from 'moment';
import Chart from 'chart.js';
import Color from 'color';

import { Harmonizer } from 'color-harmony';

import difference from 'lodash/difference';
import groupBy from 'lodash/groupBy';
import map from 'lodash/map';
import values from 'lodash/values';
import uniq from 'lodash/uniq';
import meanBy from 'lodash/meanBy';
import pickBy from 'lodash/pickBy';

import './list';

const harmonizer = new Harmonizer();
const colorMix = 'neutral';

const followedDocuments = {};

let renderedReport = null;

const reference = {
  markers: {
    'has-ccf': 'Cheque sem Fundo (CCF)',
    'has-protesto': 'Protesto',
    'rfb-invalid': 'Irregular na Receita Federal',
  },
  state: {
    ccf: 'Cheques sem Fundo (CCF)',
    protestos: 'Protestos',
  },
};

let filterConfiguration = {
  aggregateMarker: true,
  state: 'ccf',
  markers: null,
};

let chart = null;
let chartCanvas = null;
let chartReport = null;
let graphicDataset = null;

harlan.addPlugin((controller) => {
  function removeDocument(doc, after) {
    controller.server.call("DELETE FROM 'FOLLOWDOCUMENT'.'DOCUMENT'", controller.call('error::ajax', {
      dataType: 'json',
      data: { documento: doc },
      success: () => {
        controller.alert({
          icon: 'star',
          title: 'Que pena! O documento não é mais monitorado.',
          subtitle: 'Dentro de instantes não será mais possível extrair um relatório de seus cedentes e sacados com este documento incluso.',
          paragraph: 'Caso haja qualquer alteração no documento junto as instituições de crédito você não será mais avisado.',
        });
        if (after) after();
      },
    }));
  }

  controller.registerCall('followdocuments::remove', removeDocument);

  controller.registerCall('followdocuments::database', () => ({ ...followedDocuments }));

  function modalFilter() {
    controller.call('form', (data) => {
      const filter = filterConfiguration;
      filterConfiguration = data;
      if (!generateData()) {
        filterConfiguration = filter;
        controller.call('alert', {
          title: 'Infelizmente não há nenhum CPF ou CNPJ para exibir. ;(',
          subtitle: 'Experimente alterar os filtros não há nenhum CPF/CNPJ cadastrado para exibição.',
        });
      } else {
        updateChart();
      }
    }).configure({
      title: 'Acompanhamento de CPF ou CNPJ',
      subtitle: 'Preencha as informações corretamente para filtrar seus acompanhamentos.',
      paragraph: 'Diariamente, verificamos por alterações junto a instituições de crédito no documento e o alertaremos caso algo mude.',
      gamification: 'checkPoint',
      magicLabel: true,
      screens: [{
        nextButton: 'Filtrar',
        fields: [
          {
            name: 'document',
            type: 'text',
            placeholder: 'CPF ou CNPJ',
            labelText: 'CPF/CNPJ',
            mask: '000.000.000-00',
            optional: true,
            maskOptions: {
              onKeyPress(value, e, field, options) {
                const masks = ['000.000.000-000', '00.000.000/0000-00'];
                const mask = (value.length > 14) ? masks[1] : masks[0];
                field.mask(mask, options);
              },
              reverse: false,
            },
            validate({ element }) {
              const val = element.val();
              if (val) { return CPF.isValid(val) || CNPJ.isValid(val); }
              return true;
            },
          },
          [{
            name: 'state',
            type: 'select',
            optional: false,
            value: filterConfiguration.state,
            labelText: 'Agragador',
            placeholder: 'Agragador',
            list: {
              '': 'Escolha um filtro',
              ...reference.state,
            },
          },
          {
            name: 'markers',
            type: 'text',
            optional: true,
            labelText: 'Marcadores',
            placeholder: 'Marcadores (Opcional)',
          }],
          {
            name: 'rfbInvalid',
            type: 'checkbox',
            optional: true,
            value: 'true',
            labelText: 'Apenas irregulares junto a Receita Federal.',
          },
          {
            name: 'aggregateMarker',
            type: 'checkbox',
            optional: true,
            checked: filterConfiguration.aggregateMarker,
            value: true,
            labelText: 'Agregar informações desabonadoras.',
          },
        ],
      }],
    });
  }

  function createChartReport() {
    if (chartReport) return;
    chartReport = controller.call('report',
      'Relatório de Monitoramento',
      'Veja a situação dos CPFs e CNPJs acompanhados por você.',
      'Com o recurso de relatório você consegue identificar os comportamentos de risco dos cedentes e sacados, '
      + 'reconhecendo os mais propícios a inadimplência. As informações são atualizadas diáriamente, '
      + 'junto aos órgãos de crédito responsáveis.', false);
    chartReport.action('fa-print', () => {
      harlan.call('monitoramentoPDF::index');
    });
    chartReport.button('Filtros', () => modalFilter());
    chartReport.button('Gerenciar', controller.click('followdocument::modal'));
    chartReport.newContent();
    if (!renderedReport) {
      $('.app-content').prepend(chartReport.element());
    } else {
      chartReport.element().insertAfter(renderedReport);
    }
    chartCanvas = chartReport.canvas(250, 350);
  }

  function generateData() {
    const {
      state, markers, document, rfbInvalid,
    } = filterConfiguration;
    const validMarkers = markers
      ? markers.split(',').map(value => value.trim()).filter(str => !!str)
      : null;

    const database = groupBy(pickBy(values(followedDocuments),
      ({ markers: userMarkers, document: userDocument }) => {
        if (document && userDocument !== document.replace(/[^0-9]/g, '')) return false;
        if (rfbInvalid && !('rfb-invalid' in userMarkers)) return false;
        if (!validMarkers) return true;
        return !difference(validMarkers, userMarkers).length;
      }), (doc) => {
        if (filterConfiguration.aggregateMarker) {
          return uniq(doc.markers.filter(marker => /(^has-|-invalid$)/.test(marker)))
            .map(marker => reference.markers[marker])
            .sort()
            .join(', ') || 'Nada Consta';
        }

        const qtde = doc.state[state];
        const stateReference = reference.state[state];
        if (typeof qtde !== 'number') return 'Aguardando processamento';
        if (qtde <= 0) return `Sem ${stateReference}`;
        if (qtde <= 2) return `Até 2 ${stateReference}`;
        if (qtde <= 5) return `Até 5 ${stateReference}`;
        if (qtde <= 10) return `Até 10 ${stateReference}`;
        return `Mais de 10 ${stateReference}`;
      });

    if (!Object.keys(database).length) {
      return null;
    }

    const colors = {
      error: harmonizer.harmonize('#ff1a53', colorMix),
      warning: harmonizer.harmonize('#ffe500', colorMix),
      success: harmonizer.harmonize('#00ff6b', colorMix),
    };

    const backgroundColor = filterConfiguration.aggregateMarker ? map(database, (v, k) => {
      if (k === 'Nada Consta') return colors.success.shift();
      return colors.error.shift();
    }) : map(database, v => meanBy(v, `state.${state}`)).map((qtde) => {
      if (typeof qtde !== 'number' || Number.isNaN(qtde)) return colors.warning.shift();
      if (qtde === 0) return colors.success.shift();
      if (qtde <= 2) return colors.warning.shift();
      if (qtde <= 5) return colors.warning.shift();
      if (qtde <= 10) return colors.error.shift();
      return colors.error.shift();
    });

    const data = {
      labels: Object.keys(database),
      datasets: [{
        data: map(database, v => v.length),
        backgroundColor,
        hoverBackgroundColor: backgroundColor
          .map(color => new Color(color).lighten(0.1).toString()),
      }],
    };
    graphicDataset = map(database, value => value);
    return data;
  }

  function updateChart() {
    const data = generateData();
    if (!data) {
      chart = null;
      chartCanvas = null;
      graphicDataset = null;
      chartReport.element().remove();
      chartReport = null;
      return;
    }
    createChartReport();

    if (!chart) {
      chart = new Chart(chartCanvas.getContext('2d'), {
        type: 'doughnut',
        data,
        options: {
          onClick(event, [chartItem]) {
            if (!chartItem) { return; }
            const { _index: idx } = chartItem;
            const maxResults = 5;
            const results = graphicDataset[idx].slice();

            controller.call('moreResults', maxResults)
              .callback(cb => Promise.all(results.splice(0, maxResults)
                .map(({ document }) => new Promise(resolve => controller.call('ccbusca', document, element => resolve(element)), false, true)))
                .then((elements) => {
                  cb(elements.slice());
                  if (!elements.length) return;
                  elements.map(element => $('.fa.fa-minus-square-o', element).click());
                  $('html, body').animate({
                    scrollTop: elements[0].offset().top,
                  }, 2000);
                })).appendTo(chartReport.element()).show();
          },
          legend: {
            display: true,
            position: 'bottom',
          },
        },
      });
      chart.canvas.parentNode.style.height = '470px';
      chart.canvas.parentNode.style.width = '320px';
    } else {
      chart.data = data;
      chart.update();
    }
  }

  function modalFollow() {
    controller.call('form', (data) => {
      controller.server.call("INSERT INTO 'FOLLOWDOCUMENT'.'DOCUMENT'", controller.call('error::ajax', {
        dataType: 'json',
        data,
        success: () => controller.alert({
          icon: 'pass',
          title: 'Parabéns! O documento foi enviado para monitoramento.',
          subtitle: 'Dentro de instantes será possível extrair um relatório de seus cedentes e sacados com este documento incluso.',
          paragraph: 'Caso haja qualquer alteração no documento junto as instituições de crédito você será avisado.',
        }),
      }));
    }).configure({
      title: 'Acompanhamento de CPF ou CNPJ',
      subtitle: 'Preencha as informações corretamente para criar seu acompanhamento.',
      paragraph: 'Diariamente, verificamos por alterações junto a instituições de crédito no documento e o alertaremos caso algo mude.',
      gamification: 'checkPoint',
      magicLabel: true,
      screens: [{
        nextButton: 'Acompanhar',
        fields: [
          {
            name: 'documento',
            type: 'text',
            placeholder: 'CPF ou CNPJ',
            labelText: 'CPF/CNPJ',
            mask: '000.000.000-00',
            optional: false,
            maskOptions: {
              onKeyPress(value, e, field, options) {
                const masks = ['000.000.000-000', '00.000.000/0000-00'];
                const mask = (value.length > 14) ? masks[1] : masks[0];
                field.mask(mask, options);
              },
              reverse: false,
            },
            validate({ element }) {
              const val = element.val();
              if (val) { return CPF.isValid(val) || CNPJ.isValid(val); }
              return true;
            },
          },
          [{
            name: 'nascimento',
            type: 'text',
            labelText: 'Nascimento',
            optional: true,
            placeholder: 'Nascimento (Opcional)',
            mask: '00/00/0000',
            pikaday: true,
            validate({ element }) {
              if (element.val()) { return moment(element.val(), 'DD/MM/YYYY').isValid(); }
              return true;
            },
          },
          {
            name: 'Marcadores',
            type: 'text',
            optional: true,
            labelText: 'Marcadores',
            placeholder: 'Marcadores (Opcional)',
          }],
        ],
      }],
    });
  }

  function drawReport() {
    if (renderedReport) renderedReport.remove();
    const report = controller.call('report',
      'Que tal monitorar um CPF ou CNPJ?',
      'No dia em que seus cedentes e sacados apresentarem ocorrência você será notificado.',
      'O monitoramento auxilia na manutenção regular de seus clientes e fornecedores. Diariamente, nosso sistema verifica por alterações relevantes nas informações de cheques sem fundo, protestos e Receita Federal. Caso haja uma alteração, nós lhe enviaremos um e-mail para que fique por dentro de tudo.',
      false);

    report.button('Monitorar Documento', () => modalFollow());
    report.gamification('brilliantIdea');

    const reportElement = report.element();
    $('.app-content').prepend(reportElement);
    renderedReport = reportElement;
  }

  function changeDocument(args, callback) {
    callback();
    const { document } = args;
    followedDocuments[document] = args;
    updateChart();
  }

  function deleteDocument(args, callback) {
    callback();
    const { document } = args;
    delete followedDocuments[document];
    updateChart();
  }

  function fromList(list) {
    list.forEach((item) => {
      const { document } = item;
      followedDocuments[document] = item;
    });
    updateChart();
  }

  function updateList() {
    controller.server.call("SELECT FROM 'FOLLOWDOCUMENT'.'LIST'", {
      dataType: 'json',
      success: list => fromList(list),
    });
  }

  controller.registerTrigger('call::authentication::loggedin', 'followDocument', (args, callback) => {
    callback();
    updateList();
  });

  if (!controller.serverCommunication.freeKey()) {
    updateList();
  }

  controller.registerTrigger('serverCommunication::websocket::followDocument::insert', 'icheques::ban::register', changeDocument);
  controller.registerTrigger('serverCommunication::websocket::followDocument::update', 'icheques::ban::register', changeDocument);
  controller.registerTrigger('serverCommunication::websocket::followDocument::delete', 'icheques::ban::register', deleteDocument);

  controller.registerTrigger('ccbusca::parser', 'followDocument', ({ result, doc }, callback) => {
    callback();
    const document = doc.replace(/[^0-9]/g, '');
    if (!(document in followedDocuments)) { return; }
    let monitoramento = null;
    monitoramento = $('<button />')
      .text('Deixar de Acompanhar')
      .addClass('button')
      .append($('<small />').text('Interromper Acompanhamento').css({
        display: 'block',
        'font-size': '9px',
      }));

    monitoramento.click(() => {
      removeDocument(doc, () => {
        monitoramento.remove();
      });
    });
    result.addItem().prepend(monitoramento);
  });

  function submitFile(file) {
    const reader = new FileReader();
    reader.onload = async ({ target: { result } }) => {
      const documents = result
        .match(/(\d{2}(.)?\d{3}(.)?\d{3}(\/)?\d{4}(.)?\d{2}|\d{3}(.)?\d{3}(.)?\d{3}(-)?\d{2})/g)
        .filter(cpfCnpj => CPF.isValid(cpfCnpj) || CNPJ.isValid(cpfCnpj));
      if (!documents.length) {
        controller.alert({
          title: 'Não foi recebido nenhum documento para monitoramento.',
          subtitle: 'Verifique se o seu Excel possui CPFs e CNPJs para serem monitorados.',
          paragraph: 'É possível que o seu arquivo CSV esteja corrompido.',
        });
        return;
      }
      const modal = controller.call('modal');
      modal.title('Progresso de Envio de Monitoramento');
      modal.subtitle('O monitoramento está sendo enviado, por favor aguarde.');
      modal.paragraph('Experimente tomar um café enquanto nossos servidores recebem seus CPFs e CNPJs.');
      const progress = modal.addProgress();
      let sended = 0;
      try {
        await documents.reduce(async (promise, documento) => {
          await promise;
          await new Promise((resolve, reject) => controller.server.call("INSERT INTO 'FOLLOWDOCUMENT'.'DOCUMENT'", controller.call('error::ajax', {
            dataType: 'json',
            data: { documento },
            success: () => {
              sended += 1;
              progress(sended / documents.length);
              resolve();
            },
            error: (_1, _2, errorThrown) => reject(new Error(errorThrown)),
          })));
        }, Promise.resolve());
      } catch (e) {
        controller.alert({
          title: 'Uoh! Não foi possível enviar todos os documentos para monitoramento.',
          subtitle: 'Sua conexão com a internet pode estar com problemas, impedindo o envio de documentos.',
          paragraph: `Tente enviar menos documentos para que possamos realizar esta operação (${e.toString()}).`,
        });
        return;
      }
      finally {
        modal.close();
      }
      controller.alert({
        icon: 'pass',
        title: `Parabéns! Os documentos (${documents.length}) foram enviados para monitoramento.`,
        subtitle: 'Dentro de instantes será possível extrair um relatório de seus cedentes e sacados com este documento incluso.',
        paragraph: 'Caso haja qualquer alteração no documento junto as instituições de crédito você será avisado.',
      });
    };
    reader.readAsText(file);
  }

  controller.registerTrigger('dragdrop', 'followDocument', ({ files }, callback) => {
    callback();

    if (!files.length) return;
    files.map(file => submitFile(file));
  });

  drawReport();
});