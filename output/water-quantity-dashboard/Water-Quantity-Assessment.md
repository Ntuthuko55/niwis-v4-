# Water Quantity Assessment: source inspection and dashboard

Inspected and verified on 28 October 2026. Dashboard 15 follows Water Resource
Management at `/water-quantity-assessment` (alias `/water-quantity`).

## How the supplied tables operate

| Relation | Key and scope | Rows | Indicators | Reporting coverage |
| --- | --- | ---: | ---: | --- |
| `17_1_water_quantity_assessment_transfers_master` | District + reporting month | 5,152 | 8 | January 2000–October 2026 |
| `17_2_national_water_balance_master` | National reporting month | 322 | 12, including two reported summaries | January 2000–October 2026 |

The transfer table has 16 districts, each with 322 months. Fields `year`, `month`
and `date` agree. The balance table has one national record per month with
matching `Year`, `Month` and `Date`. Neither table has duplicate keys, missing
reporting rows or missing measurement values in the inspected history.

These are monthly indexed records. Transfer fields carry m³/day, kWh/ML and % FSC
units, but daily timestamps and daily observation history are absent. The tables
cannot establish the requested daily operational update without an additional
daily feed. The balance fields carry Mm³ units without an explicit monthly
accumulation or annualisation convention.

## Transfer findings

Four route columns cover Katse–Vaal, Tugela–Vaal, Orange River system transfers
and Thukela–Vaal emergency/regular transfers. Remaining columns represent loss,
pumping energy intensity, donor storage and receiving-system deficit.

All four route rates are zero in all 16 districts in October 2026. Pumping
intensity, losses and receiving deficit are also zero in those latest rows;
donor storage is 10% FSC. The source does not identify these as verified operating
states, missing-data placeholders or outages. Values are preserved and the UI
flags the absence of verification status.

Tugela and Thukela columns are separate in the schema, but scheme IDs, topology
and overlap rules are absent. They are not added into a gross transfer total.
Neither monthly transferred volume nor total pumping energy is inferred from
monthly records of rates or intensities.

## National balance findings

All 322 rows reproduce these inferred source identities within 0.025 Mm³:

```text
Total demand = Municipal + Agricultural + Industrial + Environmental Reserve
Reported net balance = MAP - AET - MAR - Recharge + Net IBT - Total demand
```

The largest rounding differences are 0.01 Mm³ for total demand and 0.02 Mm³ for
net balance. Surface storage is excluded from the stored expression. The reserve
is already included in total demand, so it is not added again. These checks
describe the supplied arithmetic; they do not validate its accounting intent.

All stored net balances are negative. The latest October 2026 row reports:

| Supplied indicator | Value (Mm³) |
| --- | ---: |
| MAP | 4,070.12 |
| AET | 3,561.36 |
| MAR | 407.01 |
| Groundwater recharge | 32.56 |
| Surface storage | 25,600.00 |
| Net IBT | 83.33 |
| Municipal demand | 402.50 |
| Agricultural demand | 1,423.12 |
| Industrial demand | 153.00 |
| Environmental Reserve | 48.84 |
| Reported total demand | 2,027.47 |
| Reported net balance | -1,874.94 |

Net IBT remains 83.33 Mm³ and industrial demand 153 Mm³ throughout the inspected
history. No metadata explains these constant fields. The approximate annual
reference volumes in the requirements are not presented as observed values or
compared directly with records of an undocumented accumulation basis.

## Dashboard behavior

- Separate transfers and national-balance views with all 20 supplied indicators,
  KPI sparklines, source-unit charts, selectors, calculation checks and CSV export.
- Full 52-district boundary map: 16 districts have source values and 36 remain
  grey. Zero is preserved as a measurement. Clicking an uncovered district
  explains its absent source data. Transfer district selection leaves national
  balance records unchanged.
- National transfer values are equal district means; no route total is invented.
  Storage stocks and monthly records are not summed into annual totals. No
  district rate is reconciled to the separately supplied national net IBT field.
- Failed reads remain explicit with retry. Successful source reads, prepared
  data and API responses use the existing bounded process-local 24-hour cache
  with shared in-flight reads. Restart or eviction can remove entries earlier.
- Forecasting keeps the national and transfer source contexts separate and uses
  monthly cadence. Missing selected inputs are rejected. Actual observations
  retain their source dates; projections are shown in the shared forecast panel.

## Verification

- 35 tests passed: nine new water-quantity checks plus existing WRM, annual
  forecasting, RWQO and drinking-water regression coverage.
- Live read-only audit checked complete pagination, native coverage, date/key
  validity, national and district source values, independent scopes, arithmetic
  identities and repeated API cache hits.
- Browser checks passed through the real frontend proxy for all indicator and
  style controls, 16 covered / 36 uncovered districts, zero handling, district
  scope, formula display, year validation, monthly CSV export, mobile layout and
  source-outage retry.
- Auto forecasts completed for both source contexts using 118 monthly
  observations, projecting November 2026 through April 2027.
- Frontend production build, Python compilation and whitespace checks passed.

Machine-readable evidence is in `database-verification.json` and
`browser-verification.json`. Screenshots are `transfers-desktop.png`,
`national-balance-desktop.png`, `transfers-mobile.png` and
`national-balance-mobile.png`.

The inspection and implementation did not modify database rows, schema,
authentication or machine networking. Database credentials remain backend-only.
