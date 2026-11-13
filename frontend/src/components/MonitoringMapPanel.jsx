import { useMemo, useState } from 'react'
import { MapPin } from 'lucide-react'
import { buildDistrictMapScale, DistrictMap, normaliseDistrictName } from './DistrictMap'
import '../niwis/monitoring-map.css'

const EMPTY = []
// For sources without a verified geographic key, keep boundaries inspectable
// while leaving every measurement missing. Never distribute a national value.
export default function MonitoringMapPanel({
  title = 'Monitoring map', description, indicators = EMPTY, rows = EMPTY,
  regionKey = 'district_name', indicator, onIndicatorChange, selected, onSelect,
  period, noDataReason, geographyAvailable = true, features,
}) {
  const [localIndicator, setLocalIndicator] = useState('')
  const [inspected, setInspected] = useState('')
  const metric = indicators.find(item => item.key === (indicator || localIndicator)) || indicators[0] || { key: 'unavailable', label: title, unit: '' }
  const mappedRows = geographyAvailable ? rows : EMPTY
  const values = useMemo(() => Object.fromEntries(mappedRows.filter(row => row?.[regionKey]).map(row => [normaliseDistrictName(row[regionKey]), row])), [mappedRows, regionKey])
  const scale = useMemo(() => buildDistrictMapScale(mappedRows, metric.key, metric.label, metric.unit, undefined, features?.length || 52), [mappedRows, metric, features])
  const changeIndicator = key => { setLocalIndicator(key); onIndicatorChange?.(key) }
  return <section className="monitoring-map-panel" aria-label={title}>
    <header><div><span className="monitoring-map-eyebrow"><MapPin size={13} /> Geographic monitoring</span><h2>{title}</h2>{description && <p>{description}</p>}</div>{period && <span className="monitoring-map-period">{period}</span>}</header>
    {noDataReason && <p className="monitoring-map-source-state" role="status">{noDataReason}</p>}
    <DistrictMap districts={features} values={values} valueKey={metric.key} valueLabel={metric.label} valueUnit={metric.unit} indicatorOptions={indicators} indicatorValue={metric.key} onIndicatorChange={changeIndicator} colorFn={scale.color} legend={scale.legend} selected={geographyAvailable && onSelect ? selected : inspected} onSelect={name => { setInspected(name); if (geographyAvailable) onSelect?.(name) }} mapId={title} />
    {!geographyAvailable && <p className="monitoring-map-note">Boundaries provide geographic reference only. Selecting a district inspects its boundary; the source filters above control the available observations. No regional measurements have been inferred.</p>}
  </section>
}
