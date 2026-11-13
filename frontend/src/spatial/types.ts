import type { FeatureCollection, Feature } from 'geojson';

export type Page = 'explorer' | 'catalogue' | 'readiness';
export type VectorLayer = 'municipalities' | 'districts' | 'wards' | 'settlements' | 'informal-settlements' | 'roads' | 'waterways' | 'waterpoints' | 'irrigation';
export type LayerId = 'provinces' | VectorLayer | 'landcover';
export interface SourceLink { label: string; url: string; note?: string }
export interface Dataset {
  id: string; title: string; description: string;
  status: 'available' | 'partial' | 'missing' | 'excluded';
  geometry: string; record_count: number | null; size_bytes: number;
  source: string; vintage: string; issue: string | null;
  map_layer: LayerId | null; files: string[];
  source_links: SourceLink[];
}
export interface Indicator { id: string; title: string; status: 'ready' | 'partial' | 'missing'; description: string; missing: string[]; sources: SourceLink[] }
export interface Catalogue {
  datasets: Dataset[]; indicators: Indicator[];
  storage: { total_bytes: number; working_bytes: number; excluded_bytes: number; file_count: number };
  verification?: string;
}
export interface LayerCollection extends FeatureCollection {
  metadata?: { returned: number; limit: number; truncated: boolean; min_zoom: number; message: string | null; source: string; display_note?: string | null; precision_note?: string };
}
export interface SelectedFeature { layer: LayerId; feature: Feature }
export interface Viewport { bounds: [number, number, number, number]; zoom: number; key: string }
export interface LayerState { data: LayerCollection | null; loading: boolean; error: string | null; message: string | null; key: string }
export interface RasterLegend { title: string; description: string; items: { value: number; label: string; color: string }[]; verified_labels: boolean }
