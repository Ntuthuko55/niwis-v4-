import { lazy, Suspense, useMemo } from 'react'
import LoadingProgress from './LoadingProgress'
import { useTheme } from '../contexts/ThemeContext'
import { resolveChartColor } from '../lib/chartTheme'

const Plot = lazy(() => import('react-plotly.js'))

function plotColour(value, theme) {
  if (Array.isArray(value)) return value.map(colour => plotColour(colour, theme))
  if (typeof value !== 'string') return value
  const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  if (!rgba) return resolveChartColor(value, theme)
  const hex = `#${rgba.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`
  const colour = resolveChartColor(hex, theme)
  return rgba[4] === undefined ? colour : `rgba(${[1, 3, 5].map(index => Number.parseInt(colour.slice(index, index + 2), 16)).join(',')},${rgba[4]})`
}

function colourFields(object, theme) {
  return object ? { ...object, ...(object.color !== undefined ? { color: plotColour(object.color, theme) } : {}) } : object
}

function lightLayout(layout = {}) {
  const result = {
    ...layout,
    paper_bgcolor: 'transparent',
    plot_bgcolor: '#ffffff',
    font: { ...layout.font, color: '#17334d' },
    legend: { ...layout.legend, font: { ...layout.legend?.font, color: '#526b80' } },
    hoverlabel: { ...layout.hoverlabel, bgcolor: '#ffffff', bordercolor: '#a5b8c8', font: { ...layout.hoverlabel?.font, color: '#17334d' } },
  }
  for (const [key, axis] of Object.entries(layout)) {
    if (!/^[xy]axis\d*$/.test(key) || !axis || typeof axis !== 'object') continue
    result[key] = {
      ...axis,
      color: '#526b80',
      gridcolor: '#dce6ee',
      linecolor: '#a5b8c8',
      zerolinecolor: '#8ea4b5',
      tickfont: { ...axis.tickfont, color: '#526b80' },
      ...(axis.title && typeof axis.title === 'object' ? { title: { ...axis.title, font: { ...axis.title.font, color: '#526b80' } } } : {}),
    }
  }
  if (layout.shapes) result.shapes = layout.shapes.map(shape => ({ ...shape, line: colourFields(shape.line, 'light'), ...(shape.fillcolor ? { fillcolor: plotColour(shape.fillcolor, 'light') } : {}) }))
  if (layout.annotations) result.annotations = layout.annotations.map(annotation => ({ ...annotation, font: colourFields(annotation.font, 'light') }))
  return result
}

export default function LazyPlot(props) {
  const { theme } = useTheme()
  const revision = useMemo(() => {
    const series = (props.data || []).map(trace => [trace.type || '', trace.name || '', trace.x?.length ?? '', trace.y?.length ?? ''].join(':')).join('|')
    return `${theme}:${series}`
  }, [props.data, theme])
  const data = useMemo(() => theme === 'navy' ? props.data : props.data?.map(trace => ({
    ...trace,
    line: colourFields(trace.line, theme),
    marker: colourFields(trace.marker, theme),
    textfont: colourFields(trace.textfont, theme),
    ...(trace.fillcolor ? { fillcolor: plotColour(trace.fillcolor, theme) } : {}),
  })), [props.data, theme])
  const layout = useMemo(() => theme === 'navy' ? props.layout : lightLayout(props.layout), [props.layout, theme])
  return <Suspense fallback={<LoadingProgress message="Loading chart" />}><Plot {...props} revision={props.revision ?? revision} data={data} layout={layout} /></Suspense>
}
