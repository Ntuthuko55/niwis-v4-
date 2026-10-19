import { lazy, Suspense } from 'react'
import LoadingProgress from './LoadingProgress'

const Plot = lazy(() => import('react-plotly.js'))

export default function LazyPlot(props) {
  return <Suspense fallback={<LoadingProgress message="Loading chart" />}><Plot {...props} /></Suspense>
}
