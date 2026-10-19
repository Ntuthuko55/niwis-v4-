import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
})

export async function uploadFile(file, sheetName = null) {
  const formData = new FormData()
  formData.append('file', file)
  if (sheetName) {
    formData.append('sheet_name', sheetName)
  }
  const response = await api.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return response.data
}

export async function previewDataset(datasetId, sheetName, rows = 10) {
  const response = await api.post('/preview', {
    dataset_id: datasetId,
    sheet_name: sheetName,
    rows,
  })
  return response.data
}

export async function analyze(datasetId, analysisType, column, params = {}, groupBy = '') {
  const response = await api.post('/analysis', {
    dataset_id: datasetId,
    analysis_type: analysisType,
    column,
    params,
    group_by: groupBy || null,
  })
  return response.data
}

export async function setDateColumn(datasetId, dateColumn) {
  const response = await api.post('/dataset/date-column', {
    dataset_id: datasetId,
    date_column: dateColumn,
  })
  return response.data
}

export async function startTraining(config) {
  const response = await api.post('/models/train', config)
  return response.data
}

export async function getTrainingJob(jobId) {
  const response = await api.get(`/models/jobs/${jobId}`)
  return { ...response.data, job_id: jobId }
}

export async function downloadPdfReport(datasetId, analysisType, column, params = {}) {
  const response = await api.post('/report/pdf', {
    dataset_id: datasetId,
    analysis_type: analysisType,
    column,
    params,
  }, { responseType: 'blob' })
  return response.data
}

export async function generateFeatures(datasetId, payload) {
  const response = await api.post('/feature-engineering/generate', {
    dataset_id: datasetId,
    ...payload,
  })
  return response.data
}

export async function getDashboardOverview(datasetId, dateColumn, selectedColumn) {
  const response = await api.post('/dashboard/overview', {
    dataset_id: datasetId,
    date_column: dateColumn,
    selected_column: selectedColumn,
  })
  return response.data
}

export async function forecast(datasetId, dateColumn, targetColumn, forecastSteps = 12) {
  const response = await api.post('/forecast', {
    dataset_id: datasetId,
    date_column: dateColumn,
    target_column: targetColumn,
    model_type: 'auto',
    forecast_steps: forecastSteps,
    include_confidence_intervals: true,
  })
  return response.data
}

export async function loadProvince(provinceId) {
  const response = await api.post(`/provinces/${provinceId}/load`)
  return response.data
}

export async function loadMeteorologicalRegion(region) {
  const response = await api.post('/meteorological/load', null, { params: { region } })
  return response.data
}

export async function registerDashboardDataset(config) {
  const response = await api.post('/dashboard/dataset', config)
  return response.data
}

export async function getProvinceSeries(datasetId, column, frequency = 'monthly') {
  const response = await api.get(`/provinces/series/${datasetId}`, { params: { column, frequency } })
  return response.data
}

export async function runComprehensiveAnalysis(datasetId, analysisType, column, params = {}) {
  const response = await api.post('/analysis/comprehensive', {
    dataset_id: datasetId,
    analysis_type: analysisType,
    column,
    params,
  })
  return response.data
}

export async function exportFeaturesCSV(datasetId) {
  const response = await api.get(`/export/features/${datasetId}`, {
    responseType: 'blob',
  })
  const url = window.URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', `features_${datasetId.slice(0, 8)}.csv`)
  document.body.appendChild(link)
  link.click()
  link.parentNode.removeChild(link)
}

export async function exportAnalysisJSON(datasetId, analysisType, column) {
  const response = await api.post('/export/analysis', null, {
    params: {
      dataset_id: datasetId,
      analysis_type: analysisType,
      column,
    },
    responseType: 'blob',
  })
  const url = window.URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', `analysis_${analysisType}_${datasetId.slice(0, 8)}.json`)
  document.body.appendChild(link)
  link.click()
  link.parentNode.removeChild(link)
}
