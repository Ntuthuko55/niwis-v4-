import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
})

export async function startTraining(config) {
  const response = await api.post('/models/train', config)
  return response.data
}

export async function getTrainingJob(jobId) {
  const response = await api.get(`/models/jobs/${jobId}`)
  return { ...response.data, job_id: jobId }
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
