# Resource Water Quality Objectives

Implemented and verified on 28 October 2026. Dashboard 13 follows Drinking Water
Quality Compliance. Open `/resource-water-quality-objectives` or `/rwqo`.

## Read-only database inspection

| Relation | Rows | Districts | Observation period |
| --- | ---: | ---: | --- |
| `15.1_ecological_variables_master` | 16,744 | 52 | January 2000–October 2026 |
| `15.2_chemical_RWQO_variables_master` | 16,744 | 52 | January 2000–October 2026 |
| `15.3_hydrological_RWQO_variables_master` | 16,744 | 52 | January 2000–October 2026 |

All three tables have matching unique district-month keys, no missing months and
no missing measurement values in the inspected history. The audit also records
each metric's range, count of negative values and number of distinct values.
Source dates use `year` and `month`, rather than import timestamps.

## Behavior

- Six ecological measurements, seven chemical measurements representing six
  objectives, and five hydrological measurements/objectives.
- National map retains all 52 districts while charts follow district and year
  filters. Map colours represent measurement magnitude, with grey for missing
  current-month observations. Older district values do not fill a later gap.
- Annual/monthly charts, three chart styles, source target references, separate
  reported chemical/hydrological scores, passing-flag summaries, recent objective
  matrices, latest failure details and monthly CSV export.
- National months weight districts equally. Annual values average each district's
  available months before averaging across districts. Gaps stay missing.
- Known flags with finite measurements enter assessment denominators. TN and TP
  require both measurements and share a single nutrient assessment.
- Successful source reads, prepared data and `/rwqo/` responses share the existing
  86,400-second cache policy. Entries are bounded and process-local; restart or
  eviction can remove them earlier. Failures are not retained. In-flight source
  reads are shared by the existing cache loader.
- The existing Forecasting Studio supports all 18 measurements at monthly
  cadence. Training rejects missing selected inputs. An Auto six-month forecast
  completed through the real registration and training APIs.

## Source limitations exposed in the UI

The source contains negative measurement values. The nutrient rule refers to DIN,
while its nitrogen column is TN. Values, stored rules and assessment flags are
preserved. Multiple targets suppress a single misleading chart reference.
Ecological records lack targets and assessment flags; no ecological compliance
grade is inferred. Habitat and vegetation columns do not establish an IHAS
protocol or calibrated index scale. Toxicants are an aggregate without individual
compound identifiers. These district-month tables do not supply individual
river reaches, dams, wetlands, aquifers, or gazetted objective metadata.

## Verification

- Eight RWQO unit/API checks: assessment denominators, shared nutrient flags,
  zero/missing values, equal district weighting, gaps, duplicate/invalid keys,
  varying targets, pagination/truncation recovery, cache hits and outage recovery.
- Seven existing drinking-water regression checks passed alongside RWQO checks.
- Read-only source audit compared national latest measurements directly with the
  database and checked district scope, complete pagination and response cache hits.
- Browser checks used the real frontend proxy to the existing port-8000 backend:
  all 18 measurement controls, three sections, 52 map districts, styles, target
  lines, district and year filters, export, forecast registration and six-month
  Auto training, mobile navigation/layout and source-error retry.
- Frontend production build and whitespace checks passed.

Machine-readable results: `database-verification.json`,
`browser-verification.json`. Screenshots: `ecological-desktop.png`,
`chemical-desktop.png`, `hydrological-desktop.png`, `mobile.png`.

No database rows, schema, authentication settings or machine networking were
changed. Browser/API source checks used the existing backend credentials.
