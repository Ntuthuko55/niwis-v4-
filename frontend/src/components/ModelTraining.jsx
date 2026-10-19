import { useEffect, useState } from 'react'
import { getTrainingJob, startTraining } from '../services/api'
import { Area, CartesianGrid, Legend, Line, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { modelGroups, modelKey, requiresFeatureSelection, lstmDefaultFeatures, preferredForecastTarget } from '../lib/modelOptions'
export { modelGroups, modelKey, requiresFeatureSelection, lstmDefaultFeatures, preferredForecastTarget } from '../lib/modelOptions'

function columnList(columns = []) {
  return columns.map((column) => (typeof column === 'string' ? column : column?.name)).filter(Boolean)
}

export default function ModelTraining({ datasetId, dateColumn, numericColumns, allColumns }) {
  const numericNames = columnList(numericColumns)
  const groupingNames = columnList(allColumns)
  const [model, setModel] = useState('LSTM')
  const [target, setTarget] = useState(preferredForecastTarget(numericNames))
  const [group, setGroup] = useState('')
  const [features, setFeatures] = useState(lstmDefaultFeatures)
  const [forecastDays, setForecastDays] = useState(365)
  const [job, setJob] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => setTarget(preferredForecastTarget(numericNames)), [numericNames.join('|')])
  useEffect(() => {
    if (!job?.job_id || ['completed', 'failed'].includes(job.status)) return
    const timer = setInterval(async () => {
      try {
        setJob(await getTrainingJob(job.job_id))
      } catch (err) {
        setError(err.response?.data?.detail || 'Unable to read the training result.')
        setJob((current) => ({ ...current, status: 'failed', message: 'Unable to read the training result.' }))
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [job?.job_id, job?.status])

  const training = job && !['completed', 'failed'].includes(job.status)
  const result = job?.result
  const [selectedModelTab, setSelectedModelTab] = useState(null)
  const multiFeatureModel = requiresFeatureSelection(model)
  const historyDates = result?.history_dates || []

  useEffect(() => {
    if (!multiFeatureModel) {
      setFeatures([])
      return
    }
    if (model !== 'LSTM') return
    setFeatures((current) => {
      const recommended = lstmDefaultFeatures.filter((feature) => numericNames.includes(feature) && feature !== target)
      if (!current.length) return recommended
      return current.filter((feature) => numericNames.includes(feature) && feature !== target)
    })
  }, [model, multiFeatureModel, numericNames.join('|'), target])
  const forecastDates = result?.forecast_dates || []
  const forecastValues = result?.forecast_values || []
  const lowerBound = result?.lower_bound || []
  const upperBound = result?.upper_bound || []
  const details = result?.details || {}
  const step = Math.max(1, Math.ceil(historyDates.length / 1000))

  const chartData = result ? [
    ...historyDates.map((date, index) => ({ date, observed: result.history_values?.[index], forecast: null, lower: null, upper: null })).filter((_, index) => index % step === 0 || index === historyDates.length - 1),
    ...forecastDates.map((date, index) => ({ date, observed: null, forecast: forecastValues[index], lower: lowerBound[index], upper: upperBound[index] })),
  ] : []

  // prepare per-model forecast source for rendering (avoid inline IIFE in JSX)
  const modelName = selectedModelTab
  let srcForecast = null
  if (modelName && details && details[modelName]) {
    const md = details[modelName]
    srcForecast = {
      history_dates: result?.history_dates || [],
      history_values: result?.history_values || [],
      forecast_dates: result?.forecast_dates || [],
      forecast_values: md.predictions || result?.forecast_values || [],
      lower_bound: md.lower || result?.lower_bound || [],
      upper_bound: md.upper || result?.upper_bound || [],
      metrics: result?.model_comparison?.[modelName] || {},
    }
  } else {
    srcForecast = {
      history_dates: result?.history_dates || [],
      history_values: result?.history_values || [],
      forecast_dates: result?.forecast_dates || [],
      forecast_values: result?.forecast_values || [],
      lower_bound: result?.lower_bound || [],
      upper_bound: result?.upper_bound || [],
      metrics: result?.metrics || {},
    }
  }
  const fdates = srcForecast.forecast_dates || []
  const fvalues = srcForecast.forecast_values || []
  const lb = srcForecast.lower_bound || []
  const ub = srcForecast.upper_bound || []
  const chartDataModel = result ? [
    ...srcForecast.history_dates.map((date, index) => ({ date, observed: srcForecast.history_values?.[index], forecast: null, lower: null, upper: null, band: null })).filter((_, index) => index % step === 0 || index === srcForecast.history_dates.length - 1),
    ...fdates.map((date, index) => {
      const lower = Number(lb[index])
      const upper = Number(ub[index])
      return {
        date,
        observed: null,
        forecast: fvalues[index],
        lower: Number.isFinite(lower) ? lower : null,
        upper: Number.isFinite(upper) ? upper : null,
        band: Number.isFinite(lower) && Number.isFinite(upper) ? Math.max(0, upper - lower) : null,
      }
    }),
  ] : []

  // When a new result arrives, default the selected tab to the selected model
  useEffect(() => {
    if (!result) return
    if (result?.selected_model) setSelectedModelTab(result.selected_model)
    else if (result?.model) setSelectedModelTab(result.model)
    else setSelectedModelTab(null)
  }, [result])

  const train = async () => {
    setError('')
    try {
      setJob(await startTraining({
        dataset_id: datasetId,
        model_type: modelKey(model),
        date_column: dateColumn,
        target,
        group_column: group || null,
        features,
        forecast_steps: forecastDays,
      }))
    } catch (err) {
      setError(err.response?.data?.detail || 'Training could not be started.')
    }
  }

  const toggleFeature = (name) => setFeatures((values) => values.includes(name) ? values.filter((item) => item !== name) : [...values, name])

  return (
    <section className="model-training">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MODEL STUDIO</p>
          <h2>Train a forecasting model</h2>
          <p className="section-description">Select a model and forecast range. The system automatically selects the best model when "Auto" is chosen.</p>
        </div>
      </div>
      {!dateColumn ? (
        <div className="info-box">Choose a date column before starting training.</div>
      ) : (
        <>
          <div className="training-form">
            <label>Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {modelGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map((item) => <option key={item}>{item}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>{multiFeatureModel ? 'Primary target' : 'Target'}
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {numericNames.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>Group (optional)
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">No grouping</option>
                {groupingNames.filter((item) => item !== dateColumn).map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>Forecast range
              <select value={forecastDays} onChange={(e) => setForecastDays(Number(e.target.value))}>
                <option value={90}>3 months (quarterly)</option>
                <option value={180}>6 months (half-yearly)</option>
                <option value={365}>2026 (1 year)</option>
                <option value={730}>2026–2027 (2 years)</option>
                <option value={1095}>2026–2028 (3 years)</option>
                <option value={1825}>2026–2030 (5 years)</option>
              </select>
            </label>
          </div>
          {multiFeatureModel && (
            <div className="feature-picker">
              <strong>Additional forecasting features</strong>
              <span>{model === 'LSTM' ? 'LSTM uses the selected climate variables as its 12-month input sequence. Recommended monthly inputs are selected automatically; you can adjust them before training.' : 'For VAR, VARMAX, GARCH, Transformer and state-space models, include extra numerical series used alongside the primary target.'}</span>
              <div>{numericNames.filter((item) => item !== target).map((item) => <label key={item} className="check-label"><input type="checkbox" checked={features.includes(item)} onChange={() => toggleFeature(item)} />{item}</label>)}</div>
            </div>
          )}
          <button className="primary-button" disabled={training || !target} onClick={train}>
            {training ? 'Training…' : `Train ${model} & forecast`}
          </button>
        </>
      )}
      {error && <div className="province-error">{error}</div>}
      {job && (
        <div className={`training-status ${job.status}`}>
          <strong>{job.message}</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            {job.estimated_minutes != null && <div style={{ fontSize: '0.85rem', color: '#475569' }}>Estimated: <b>{job.estimated_minutes}m</b></div>}
            {['queued','running'].includes(job.status) && (
              <div style={{ width: 18, height: 18 }} aria-hidden>
                <svg width="18" height="18" viewBox="0 0 50 50">
                  <circle cx="25" cy="25" r="20" stroke="#0ea5a4" strokeWidth="4" fill="none" strokeLinecap="round" strokeDasharray="31.4 31.4">
                    <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite" />
                  </circle>
                </svg>
              </div>
            )}
          </div>
          {job.progress !== undefined && <div className="progress"><i style={{ width: `${job.progress}%` }} /></div>}
          
          {training && (
            <div className="info-box" style={{ marginTop: '12px' }}>
              Training model and running cross-validation folds. Please wait a moment...
            </div>
          )}

              {job.status === 'completed' && result && (
                <div className="success-box" style={{ marginTop: '12px', padding: '12px', borderRadius: 8, background: '#ecfdf5', border: '1px solid #bbf7d0' }}>
                  <strong>Training complete</strong>
                  <div style={{ marginTop: 6 }}>Model: <b>{String(result.selected_model || result.model_type || model).toUpperCase()}</b></div>
                  <div style={{ marginTop: 6 }}>MAE: <b>{result?.metrics?.mae != null ? Number(result.metrics.mae).toFixed(3) : '—'}</b> &nbsp; RMSE: <b>{result?.metrics?.rmse != null ? Number(result.metrics.rmse).toFixed(3) : '—'}</b></div>
                </div>
              )}

              {job.status === 'completed' && result && (
            <>
                {/* Model tabs for multivariate / comparison results */}
                {result.comparison_table?.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {result.comparison_table.map((row) => (
                        <button key={row.model} onClick={() => setSelectedModelTab(row.model)} style={{ padding: '8px 12px', borderRadius: 8, border: row.model === selectedModelTab ? '2px solid #0ea5a4' : '1px solid #e2e8f0', background: row.model === selectedModelTab ? '#ecfeff' : '#fff', minWidth: 160, textAlign: 'left' }}>
                          <div style={{ fontWeight: 600 }}>{row.model}</div>
                          <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: 4 }}>
                            MAE: {row.mae != null ? Number(row.mae).toFixed(3) : '—'} • RMSE: {row.rmse != null ? Number(row.rmse).toFixed(3) : '—'}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 4 }}>
                            {row.training_time != null ? `${Number(row.training_time).toFixed(1)}s` : '—'}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Render model metrics, comparison table, warnings and forecast output using precomputed `srcForecast` */}
                <div className="metrics">
                  <span>Model <b>{String(result.selected_model || result.model_type || '').toUpperCase()}</b></span>
                  <span>MAE <b>{srcForecast.metrics?.mae != null ? Number(srcForecast.metrics.mae).toFixed(3) : '—'}</b></span>
                  <span>RMSE <b>{srcForecast.metrics?.rmse != null ? Number(srcForecast.metrics.rmse).toFixed(3) : '—'}</b></span>
                  <span>Forecast values <b>{fvalues.length}</b></span>
                  {result.seasonality_detected && <span className="badge season">Seasonality detected</span>}
                </div>

                {result.comparison_table?.length > 0 && (
                  <div style={{ margin: '16px 0', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', overflowX: 'auto' }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: '0.9rem', color: '#334155' }}>Model comparison (chronological holdout, sorted by RMSE)</h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                      <thead>
                        <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                          <th style={{ padding: '6px 8px' }}>Model</th>
                          <th style={{ padding: '6px 8px' }}>MAE</th>
                          <th style={{ padding: '6px 8px' }}>RMSE</th>
                          <th style={{ padding: '6px 8px' }}>R²</th>
                          <th style={{ padding: '6px 8px' }}>Train time (s)</th>
                          <th style={{ padding: '6px 8px' }}>Selected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.comparison_table.map((row, i) => (
                          <tr key={`${row.model}-${i}`} style={{ background: row.selected ? '#fff7ed' : 'transparent', fontWeight: row.selected ? 600 : 400, borderBottom: '1px solid #eef2f7' }}>
                            <td style={{ padding: '6px 8px' }}>{row.model}</td>
                            <td style={{ padding: '6px 8px' }}>{row.mae != null ? Number(row.mae).toFixed(3) : '—'}</td>
                            <td style={{ padding: '6px 8px' }}>{row.rmse != null ? Number(row.rmse).toFixed(3) : '—'}</td>
                            <td style={{ padding: '6px 8px' }}>{row.r_squared != null ? Number(row.r_squared).toFixed(3) : '—'}</td>
                            <td style={{ padding: '6px 8px' }}>{row.training_time != null ? Number(row.training_time).toFixed(1) : '—'}</td>
                            <td style={{ padding: '6px 8px' }}>{row.selected ? '✓' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {result.warnings?.length > 0 && (
                  <div className="warning-box">
                    <strong>Forecast notes:</strong>
                    <ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}

                <div className="prediction-output">
                  <div className="prediction-heading">
                    <div>
                      <h3>Forecast trajectory</h3>
                      <p>Observed history joins the forecast at the dashed start line. The blue cone is the returned 95% confidence interval.</p>
                    </div>
                  </div>
                  <div className="prediction-chart">
                    <ResponsiveContainer width="100%" height={330}>
                      <ComposedChart data={chartDataModel}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#dbe7ee" />
                        <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(0, 10)} minTickGap={40} />
                        <YAxis />
                        <Tooltip formatter={(value) => Number(value).toFixed(3)} />
                        <Legend />
                        {fdates[0] && <ReferenceLine x={fdates[0]} stroke="#2fa8c9" strokeDasharray="5 5" label={{ value: 'Forecast start', position: 'insideTopLeft', fill: '#26728a', fontSize: 11 }} />}
                        {lb?.length > 0 && <Area dataKey="lower" stackId="confidence" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                        {lb?.length > 0 && <Area dataKey="band" stackId="confidence" name="95% confidence range" stroke="none" fill="#7dd3fc" fillOpacity={0.32} isAnimationActive={false} />}
                        <Line dataKey="observed" name="Historical" stroke="#456b75" strokeWidth={2.2} dot={false} isAnimationActive={false} connectNulls />
                        <Line dataKey="forecast" name="Forecast" stroke="#0284c7" strokeWidth={2.8} dot={false} isAnimationActive={false} connectNulls />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="prediction-table-wrap">
                    <table className="prediction-table">
                      <thead>
                        <tr>
                          <th>Forecast date</th>
                          <th>Forecast value</th>
                          <th>Lower CI</th>
                          <th>Upper CI</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fdates.map((date, index) => (
                          <tr key={date}>
                            <td>{String(date).slice(0, 10)}</td>
                            <td>{Number(fvalues[index]).toFixed(3)}</td>
                            <td>{lb?.[index] !== undefined && lb[index] !== null ? Number(lb[index]).toFixed(3) : '—'}</td>
                            <td>{ub?.[index] !== undefined && ub[index] !== null ? Number(ub[index]).toFixed(3) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
            </>
          )}

          {job.status === 'completed' && (!result || forecastValues.length === 0) && (
            <div className="info-box">No forecast values generated for this configuration.</div>
          )}
        </div>
      )}
    </section>
  )
}
