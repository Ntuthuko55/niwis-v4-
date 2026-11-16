import { droughtIndicatorDetails } from '../lib/droughtIndicators'
import '../niwis/drought-indicators.css'

export default function DroughtIndicatorHelp({ indicator, forecast = false }) {
  const details = droughtIndicatorDetails(indicator)
  if (!details) return null
  return <div className="nw-drought-index-help" role="note" aria-label="About the selected drought indicator">
    <strong>{details.label}</strong>
    <p>{details.description} {details.purpose}</p>
    <small>Negative values mean drier conditions; positive values mean wetter conditions.
      {forecast && ` This indicator summarises ${details.period} of conditions. The Horizon setting controls how far ahead the model predicts.`}
    </small>
  </div>
}
