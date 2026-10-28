export const DCLASS = {
  '-': { n: 'No drought', c: 'var(--ok)', t: 't-ok' },
  D0: { n: 'Abnormally dry', c: 'var(--d0)', t: 't-d0', spi: '−0.50 to −0.79', prob: '20–30%', imp: 'Pasture and crop stress starting' },
  D1: { n: 'Moderate drought', c: 'var(--d1)', t: 't-d1', spi: '−0.80 to −1.29', prob: '10–20%', imp: 'Streams and dams running low' },
  D2: { n: 'Severe drought', c: 'var(--d2)', t: 't-d2', spi: '−1.30 to −1.59', prob: '5–10%', imp: 'Water shortages common' },
  D3: { n: 'Extreme drought', c: 'var(--d3)', t: 't-d3', spi: '−1.60 to −1.99', prob: '2–5%', imp: 'Major water restrictions' },
  D4: { n: 'Exceptional drought', c: 'var(--d4)', t: 't-d4', spi: '≤ −2.00', prob: '< 2%', imp: 'Water emergency declared' },
}

export const PROV_META = [
  { id: 'EC', name: 'Eastern Cape', cma: 'Mzimvubu-Tsitsikamma' },
  { id: 'NC', name: 'Northern Cape', cma: 'Orange' },
  { id: 'WC', name: 'Western Cape', cma: 'Breede-Olifants' },
  { id: 'FS', name: 'Free State', cma: 'Vaal' },
  { id: 'NW', name: 'North West', cma: 'Limpopo-Olifants' },
  { id: 'LP', name: 'Limpopo', cma: 'Limpopo-Olifants' },
  { id: 'GP', name: 'Gauteng', cma: 'Vaal' },
  { id: 'MP', name: 'Mpumalanga', cma: 'Inkomati-Usuthu' },
  { id: 'KZ', name: 'KwaZulu-Natal', cma: 'Pongola-Mtamvuna' },
]

export const NAME_TO_ID = Object.fromEntries(PROV_META.map((p) => [p.name, p.id]))

// Baseline drought indicators used only while the prediction service has not
// returned a trained-model result. They keep the operational overview useful
// without presenting sample values as an actual forecast.
export const BASELINE_PROVINCES = {
  'Eastern Cape': { spi: -0.98, d: 'D1', rain6: 130, rainAnomaly: -26, tempAnomaly: 0.9, soilDeficit: 57 },
  'Free State': { spi: -1.05, d: 'D1', rain6: 116, rainAnomaly: -31, tempAnomaly: 1.1, soilDeficit: 61 },
  Gauteng: { spi: -1.38, d: 'D2', rain6: 124, rainAnomaly: -42, tempAnomaly: 1.6, soilDeficit: 68 },
  'KwaZulu-Natal': { spi: -1.26, d: 'D1', rain6: 182, rainAnomaly: -24, tempAnomaly: 1.2, soilDeficit: 53 },
  Limpopo: { spi: -0.62, d: 'D0', rain6: 78, rainAnomaly: -16, tempAnomaly: 1.4, soilDeficit: 44 },
  Mpumalanga: { spi: -0.87, d: 'D1', rain6: 94, rainAnomaly: -22, tempAnomaly: 1.3, soilDeficit: 51 },
  'North West': { spi: -1.21, d: 'D1', rain6: 72, rainAnomaly: -35, tempAnomaly: 1.5, soilDeficit: 64 },
  'Northern Cape': { spi: -0.45, d: '-', rain6: 41, rainAnomaly: -12, tempAnomaly: 1.0, soilDeficit: 39 },
  'Western Cape': { spi: -0.72, d: 'D0', rain6: 105, rainAnomaly: -18, tempAnomaly: 0.7, soilDeficit: 42 },
}

export const GEO = {
  WC: [[17.9, -32.8], [18.3, -34.4], [19.5, -34.8], [20.8, -34.5], [22.2, -34.1], [23.6, -34.0], [24.2, -33.4], [23.9, -32.6], [22.5, -32.2], [21.0, -31.6], [19.2, -31.7], [18.2, -31.9], [17.2, -30.9]],
  NC: [[16.5, -28.5], [17.4, -28.0], [19.0, -28.5], [19.9, -28.4], [20.0, -24.9], [20.9, -26.4], [22.8, -26.1], [23.0, -27.8], [24.6, -28.6], [25.0, -30.0], [24.9, -31.5], [23.9, -32.6], [22.5, -32.2], [21.0, -31.6], [19.2, -31.7], [18.2, -31.9], [17.2, -30.9], [17.2, -30.5]],
  EC: [[24.2, -33.4], [23.9, -32.6], [24.9, -31.5], [25.0, -30.0], [26.5, -30.6], [27.4, -30.6], [28.1, -30.3], [29.3, -30.0], [30.0, -30.9], [29.5, -31.8], [28.5, -32.5], [27.3, -33.3], [26.0, -33.8], [25.0, -34.1]],
  FS: [[25.0, -30.0], [24.6, -28.6], [26.0, -27.6], [27.3, -26.8], [28.4, -27.3], [29.4, -27.8], [29.0, -28.6], [28.9, -29.4], [29.3, -30.0], [28.1, -30.3], [27.4, -30.6], [26.5, -30.6]],
  KZ: [[29.4, -27.8], [30.0, -27.3], [31.0, -27.0], [32.1, -26.8], [32.9, -27.5], [32.3, -28.6], [31.2, -29.6], [30.5, -30.6], [30.0, -30.9], [29.3, -30.0], [28.9, -29.4], [29.0, -28.6]],
  NW: [[22.8, -26.1], [24.0, -25.6], [25.5, -25.7], [26.4, -24.9], [27.3, -25.3], [27.2, -26.2], [27.3, -26.8], [26.0, -27.6], [24.6, -28.6], [23.0, -27.8]],
  GP: [[27.2, -26.2], [27.3, -25.3], [28.4, -25.2], [29.1, -25.7], [28.9, -26.5], [28.4, -27.3], [27.3, -26.8]],
  MP: [[28.9, -26.5], [29.1, -25.7], [29.2, -24.6], [30.8, -24.3], [31.9, -25.5], [31.9, -26.5], [30.9, -26.9], [30.0, -27.3], [29.4, -27.8], [28.4, -27.3]],
  LP: [[26.4, -24.9], [27.0, -23.6], [28.3, -22.6], [29.4, -22.1], [31.3, -22.4], [31.5, -23.5], [30.8, -24.3], [29.2, -24.6], [29.1, -25.7], [28.4, -25.2], [27.3, -25.3]],
}
export const LESOTHO = [[27.0, -30.1], [28.1, -28.6], [29.4, -28.9], [29.4, -30.1], [28.0, -30.7]]
export const LABELPOS = { WC: [20.6, -33.3], NC: [21.0, -29.2], EC: [26.8, -32.0], FS: [26.8, -28.8], KZ: [30.7, -28.6], NW: [25.2, -26.6], GP: [28.1, -26.1], MP: [30.4, -25.8], LP: [29.2, -23.4] }

export const DAMS = [
  { n: 'Gariep', p: 'Free State', r: 'Orange', cap: 5341, fsc: 44.1, wk: -1.7, in: 38, out: 96, dte: 186 },
  { n: 'Vanderkloof', p: 'Northern Cape', r: 'Orange', cap: 3171, fsc: 39.6, wk: -2.1, in: 22, out: 78, dte: 141 },
  { n: 'Sterkfontein', p: 'Free State', r: 'Nuwejaarspruit', cap: 2617, fsc: 88.4, wk: -0.2, in: 9, out: 11, dte: 999 },
  { n: 'Vaal', p: 'Gauteng / Free State', r: 'Vaal', cap: 2536, fsc: 57.3, wk: -1.4, in: 41, out: 88, dte: 224 },
  { n: 'Pongolapoort', p: 'KwaZulu-Natal', r: 'Phongolo', cap: 2448, fsc: 74.8, wk: 0.6, in: 63, out: 44, dte: 999 },
  { n: 'Katse (LHWP)', p: 'Lesotho — transfer', r: 'Malibamatso', cap: 1950, fsc: 61.9, wk: -0.9, in: 28, out: 51, dte: 311 },
  { n: 'Bloemhof', p: 'North West', r: 'Vaal', cap: 1232, fsc: 49.2, wk: -1.8, in: 19, out: 57, dte: 167 },
  { n: 'Theewaterskloof', p: 'Western Cape', r: 'Sonderend', cap: 480, fsc: 46.5, wk: -2.4, in: 6, out: 19, dte: 118 },
  { n: 'Loskop', p: 'Mpumalanga', r: 'Olifants', cap: 374, fsc: 68.1, wk: -0.7, in: 12, out: 18, dte: 402 },
  { n: 'Kouga', p: 'Eastern Cape', r: 'Kouga', cap: 128, fsc: 21.4, wk: -3.1, in: 2, out: 8, dte: 61 },
  { n: 'Gamkapoort', p: 'Western Cape', r: 'Gamka', cap: 42, fsc: 14.8, wk: -2.9, in: 1, out: 3, dte: 47 },
  { n: 'Nandoni', p: 'Limpopo', r: 'Luvuvhu', cap: 164, fsc: 72.3, wk: -0.4, in: 8, out: 10, dte: 999 },
]

export const STATIONS = [
  { id: 'C1H007', n: 'Vaal @ Standerton', q: 18.4, pct: 22, state: 'Low', lon: 29.24, lat: -26.95 },
  { id: 'D3H012', n: 'Orange @ Aliwal North', q: 31.2, pct: 14, state: 'Very low', lon: 26.71, lat: -30.69 },
  { id: 'H1H018', n: 'Breede @ Ceres', q: 2.1, pct: 9, state: 'Very low', lon: 19.31, lat: -33.37 },
  { id: 'V2H016', n: 'Thukela @ Colenso', q: 44.7, pct: 58, state: 'Normal', lon: 29.82, lat: -28.74 },
  { id: 'B4H009', n: 'Olifants @ Loskop', q: 12.9, pct: 34, state: 'Low', lon: 29.35, lat: -25.42 },
  { id: 'A7H004', n: 'Luvuvhu @ Punda Maria', q: 6.3, pct: 41, state: 'Low', lon: 31.02, lat: -22.69 },
  { id: 'L2H005', n: 'Gamka @ Prince Albert', q: 0.4, pct: 3, state: 'Critical', lon: 22.03, lat: -33.22 },
  { id: 'C8H021', n: 'Caledon @ Ficksburg', q: 9.8, pct: 27, state: 'Low', lon: 27.87, lat: -28.87 },
  { id: 'D7H008', n: 'Orange @ Vioolsdrif', q: 24.6, pct: 11, state: 'Very low', lon: 17.73, lat: -28.76 },
  { id: 'U2H013', n: 'Mgeni @ Howick', q: 15.2, pct: 63, state: 'Normal', lon: 30.22, lat: -29.48 },
]

export const BOREHOLES = [
  { id: 'NGA-04412', n: 'Beaufort West WF3', depth: 41.8, sgi: -2.14, trend: -2.9, tele: true },
  { id: 'NGA-11907', n: 'Hartswater Irrigation', depth: 22.4, sgi: -1.37, trend: -1.1, tele: true },
  { id: 'NGA-02255', n: 'Grahamstown Reserve', depth: 35.1, sgi: -1.82, trend: -2.2, tele: false },
  { id: 'NGA-08761', n: 'Polokwane North', depth: 29.6, sgi: -1.04, trend: -0.8, tele: true },
  { id: 'NGA-15330', n: 'Atlantis Recharge', depth: 11.2, sgi: 0.42, trend: 0.6, tele: true },
  { id: 'NGA-06018', n: 'Delmas Dolomite', depth: 18.9, sgi: -0.51, trend: -0.3, tele: true },
  { id: 'NGA-13244', n: 'Kuruman Eye', depth: 8.4, sgi: -0.88, trend: -0.9, tele: false },
]

export const WQSITES = [
  { n: 'Hartbeespoort Dam', prov: 'NW', ph: 8.9, do: 4.1, ec: 78, turb: 26, chla: 184, ecoli: 1200, st: 'Poor' },
  { n: 'Vaal Barrage', prov: 'GP', ph: 7.8, do: 6.2, ec: 112, turb: 41, chla: 62, ecoli: 3400, st: 'Poor' },
  { n: 'Orange @ Upington', prov: 'NC', ph: 7.9, do: 7.8, ec: 41, turb: 18, chla: 12, ecoli: 180, st: 'Good' },
  { n: 'Berg @ Paarl', prov: 'WC', ph: 7.4, do: 8.1, ec: 36, turb: 9, chla: 8, ecoli: 640, st: 'Fair' },
  { n: 'Olifants @ Phalaborwa', prov: 'LP', ph: 8.4, do: 5.4, ec: 96, turb: 33, chla: 44, ecoli: 2100, st: 'Poor' },
  { n: 'Mgeni @ Nagle', prov: 'KZ', ph: 7.6, do: 8.4, ec: 22, turb: 6, chla: 5, ecoli: 90, st: 'Good' },
  { n: 'Sundays @ Kirkwood', prov: 'EC', ph: 8.1, do: 6.6, ec: 128, turb: 22, chla: 31, ecoli: 880, st: 'Fair' },
]

export const BLUEDROP = [
  { n: 'City of Cape Town', prov: 'WC', sys: 12, comp: 99.4, risk: 14, micro: 100, chem: 99.1, st: 'Excellent' },
  { n: 'City of Tshwane', prov: 'GP', sys: 9, comp: 97.8, risk: 29, micro: 99.2, chem: 97.4, st: 'Good' },
  { n: 'eThekwini', prov: 'KZ', sys: 11, comp: 98.6, risk: 22, micro: 99.7, chem: 98.2, st: 'Good' },
  { n: 'Emfuleni', prov: 'GP', sys: 4, comp: 82.1, risk: 71, micro: 88.4, chem: 91.0, st: 'Poor' },
  { n: 'Makana', prov: 'EC', sys: 3, comp: 74.6, risk: 84, micro: 79.2, chem: 86.3, st: 'Critical' },
  { n: 'Lekwa', prov: 'MP', sys: 3, comp: 79.9, risk: 77, micro: 84.1, chem: 88.8, st: 'Critical' },
  { n: 'Polokwane', prov: 'LP', sys: 6, comp: 93.2, risk: 41, micro: 96.8, chem: 94.0, st: 'Fair' },
]

export const GREENDROP = [
  { n: 'Rooiwal WWTW', prov: 'GP', cap: 180, load: 118, bod: 42, cod: 128, nh3: 14.2, ecoli: 24000, risk: 88, st: 'Critical' },
  { n: 'Northern Works', prov: 'GP', cap: 450, load: 71, bod: 11, cod: 48, nh3: 2.1, ecoli: 180, risk: 24, st: 'Good' },
  { n: 'Zandvliet WWTW', prov: 'WC', cap: 90, load: 94, bod: 14, cod: 56, nh3: 3.4, ecoli: 420, risk: 33, st: 'Good' },
  { n: 'Umbilo WWTW', prov: 'KZ', cap: 52, load: 103, bod: 28, cod: 94, nh3: 8.8, ecoli: 6400, risk: 66, st: 'Poor' },
  { n: 'Sebokeng WWTW', prov: 'GP', cap: 150, load: 127, bod: 58, cod: 166, nh3: 19.4, ecoli: 41000, risk: 92, st: 'Critical' },
  { n: 'Mbombela WWTW', prov: 'MP', cap: 38, load: 88, bod: 19, cod: 72, nh3: 5.2, ecoli: 1400, risk: 47, st: 'Fair' },
]

export const TARIFFS = [
  { sch: 'Vaal River System', raw: 3.84, d: 6.2, cost: 'Storage + LHWP transfer', users: 'Municipal, industrial, irrigation' },
  { sch: 'Orange River Project', raw: 2.61, d: 5.1, cost: 'Storage + conveyance', users: 'Irrigation, municipal' },
  { sch: 'Western Cape Supply', raw: 4.12, d: 8.4, cost: 'Storage + augmentation levy', users: 'Municipal, agriculture' },
  { sch: 'Crocodile West', raw: 3.19, d: 4.8, cost: 'Return flow + storage', users: 'Mining, municipal' },
  { sch: 'Mhlathuze System', raw: 2.44, d: 3.9, cost: 'Storage + pumping', users: 'Industrial, irrigation' },
]

export const SETTLEMENTS = [
  { n: 'Sutherland', prov: 'NC', pop: 2870, d: 'D4', days: 0, src: 'Boreholes (3 of 5 dry)', risk: 94, tank: true },
  { n: 'Graaff-Reinet', prov: 'EC', pop: 35800, d: 'D4', days: 38, src: 'Nqweba Dam 6% FSC', risk: 91, tank: true },
  { n: 'Beaufort West', prov: 'NC', pop: 41500, d: 'D3', days: 52, src: 'Gamka Dam + wellfield', risk: 88, tank: true },
  { n: 'Makhanda', prov: 'EC', pop: 91000, d: 'D3', days: 74, src: 'Settlers Dam + Howiesons', risk: 79, tank: true },
  { n: 'Prince Albert', prov: 'WC', pop: 7400, d: 'D3', days: 66, src: 'Springs + boreholes', risk: 74, tank: false },
  { n: 'Senekal', prov: 'FS', pop: 19200, d: 'D2', days: 118, src: 'Sand River Dam', risk: 58, tank: false },
]

export const MODELS = [
  { n: 'Drought class forecast', arch: 'Regression ensemble (this project)', in: 'Rainfall, temperature, PET, humidity, wind', out: 'SPI and D0–D4 class', acc: 'Heuristic consensus', lead: 'Latest observation', st: 'Production', ver: 'v0.live', drift: 'low', live: true },
  { n: 'Streamflow forecast', arch: 'CNN-LSTM', in: 'Rainfall, soil moisture', out: 'Discharge 7–90 days', acc: '—', lead: '90 days', st: 'Not connected', ver: '—', drift: '—' },
  { n: 'Reservoir level forecast', arch: 'Random Forest + LSTM', in: 'Inflow, demand, evaporation', out: '% FSC', acc: '—', lead: '180 days', st: 'Not connected', ver: '—', drift: '—' },
  { n: 'Water quality exceedance', arch: 'Gradient boosting', in: 'Flow, rainfall', out: 'SANS 241 failure risk', acc: '—', lead: '14 days', st: 'Not connected', ver: '—', drift: '—' },
  { n: 'Vegetation health forecast', arch: 'CNN + LSTM', in: 'SPI, NDVI, LST', out: '30-day VHI grid', acc: '—', lead: '30 days', st: 'Not connected', ver: '—', drift: '—' },
  { n: 'Groundwater level forecast', arch: 'Autoregressive LSTM', in: 'Rainfall, ET, abstraction', out: 'm bgl', acc: '—', lead: '12 months', st: 'Not connected', ver: '—', drift: '—' },
]

export const LIVE_SOURCE = {
  n: 'NIWIS daily climate (Supabase)', proto: 'PostgREST', freq: 'Daily', vol: '9 provinces', lat: 'Warehouse', health: 100, st: 'ok', fmt: 'JSON', live: true,
}

export const MISSING_SOURCES = [
  { n: 'SAWS automatic weather stations', proto: 'REST + MQTT', freq: '15 min', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'JSON / BUFR' },
  { n: 'DWS hydrological gauges (WISKI)', proto: 'REST', freq: '15 min', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'WaterML 2.0' },
  { n: 'DWS dam storage (Hydstra)', proto: 'CSV', freq: 'Daily', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'CSV' },
  { n: 'SANSA EO products', proto: 'S3', freq: 'Daily', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'GeoTIFF' },
  { n: 'Municipal supply data (WSNIS)', proto: 'REST', freq: 'Monthly', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'JSON' },
  { n: 'DWS water quality (NWQMS)', proto: 'Database', freq: 'Monthly', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'XML' },
  { n: 'National Groundwater Archive', proto: 'Database', freq: 'Weekly', vol: '—', lat: '—', health: 0, st: 'down', fmt: 'CSV' },
]

export const SOURCES = [LIVE_SOURCE, ...MISSING_SOURCES]

export const INDICES = [
  ['SPI', 'Standardised Precipitation Index', 'Rainfall', 'Meteorological'],
  ['SPEI', 'Standardised Precipitation-Evapotranspiration Index', 'Rainfall + PET', 'Meteorological + thermal'],
  ['VCI', 'Vegetation Condition Index', 'NDVI against historical range', 'Agricultural'],
  ['SSI', 'Standardised Streamflow Index', 'River discharge', 'Hydrological'],
  ['RSI', 'Reservoir Storage Index', 'Dam storage % FSC', 'Hydrological'],
  ['SGI', 'Standardised Groundwater Index', 'Borehole levels', 'Groundwater'],
]

export const BALANCE = [
  ['Mean annual precipitation', 'MAP', 495000, 'SAWS'],
  ['Mean annual evapotranspiration', 'AET', 430000, 'Modelled'],
  ['Mean annual runoff', 'MAR', 49000, 'DWS'],
  ['Groundwater recharge', 'R', 19000, 'DWS / WRC'],
  ['Municipal demand', 'D_m', 4200, 'DWS'],
  ['Agricultural demand', 'D_a', 11000, 'DWS / NDA'],
]

export const ROADMAP = [
  { ph: 'Phase 1 — Foundation', mo: 'What this project has now', st: 'now', items: [
    ['Supabase climate warehouse (niwis_daily_climate_v2)', 'done'],
    ['Province-level drought scoring from latest observation', 'done'],
    ['Monitoring dashboard forecasts', 'done'],
    ['Prototype portal layout for the full NIWIS catalogue', 'now'],
    ['DWS / SAWS / SANSA operational feeds', 'next'],
  ] },
  { ph: 'Phase 2 — Expansion', mo: 'Feeds not in this warehouse', st: 'next', items: [
    ['Dam storage (Hydstra)', 'next'],
    ['Gauging stations and SSI', 'next'],
    ['National Groundwater Archive', 'next'],
    ['NWQMS, Blue Drop and Green Drop', 'next'],
    ['SANSA vegetation and soil moisture', 'next'],
  ] },
  { ph: 'Phase 3 — Intelligence', mo: 'Once monitoring is connected', st: 'next', items: [
    ['Ensemble models across eight domains', 'next'],
    ['National water system digital twin', 'next'],
    ['CMIP6 climate scenario integration', 'next'],
    ['Open data API for researchers', 'next'],
  ] },
]

export const ROLES = [
  { k: 'E', id: 'exec', n: 'Executive', d: 'Minister, DG and provincial heads — national status, risk and briefing packs' },
  { k: 'A', id: 'analyst', n: 'Water resource analyst', d: 'Full data access, index workbench, model outputs and exports' },
  { k: 'F', id: 'field', n: 'Field officer', d: 'Assigned stations, sample capture and offline-first mobile view' },
  { k: 'M', id: 'muni', n: 'Municipal / WSA', d: 'Own systems only — supply, quality compliance and outages' },
  { k: 'P', id: 'public', n: 'Public', d: 'Open dashboard, dam levels, water quality and restriction notices' },
  { k: 'S', id: 'admin', n: 'System administrator', d: 'Pipelines, data quality, users, roles and audit logs' },
]

export const NAV = [
  ['Monitoring', [
    ['monitoring', 'Drought', '1', false, [
      ['monitoring', 'Drought Monitoring', '', false],
      ['overview', 'Meteorological', '', false],
      ['hydrology', 'Hydrological Drought', '', false],
      ['satellite', 'Satellite & Remote Sensing', '', false],
    ]],
    ['climate', 'Climate', '2', false, [
      ['climate', 'Climate Dashboard', '', false],
      ['climate-temperature', 'Temperature Change Variables', '', false],
      ['climate-spells', 'Wet and Dry Spell Variables', '', false],
      ['climate-rainfall', 'Mean Annual Precipitation (MAP)', '', false],
      ['climate-evaporation', 'Potential Evaporation Variables', '', false],
      ['climate-irrigation', 'Irrigation Demand Variables', '', false],
      ['climate-streamflow', 'Streamflow and Climate Linkage', '', false],
    ]],
    ['vegetation', 'Vegetation Condition Monitoring', '3', false],
    ['rainfall', 'Rainfall Status Monitoring', '4', false],
    ['runoff', 'Runoff Status Monitoring', '5', false],
    ['surface', 'Surface Water Monitoring Network', '6', false],
    ['groundwater', 'Groundwater Level Monitoring Network', '7', false],
    ['groundwater-reserve', 'Groundwater Reserve Assessment', '8', false],
    ['water-quality', 'Water Quality Monitoring Network', '9', false],
    ['dams', 'Dam and Reservoir Status', '10', false],
    ['wastewater', 'Wastewater Quality Compliance', '11', false],
    ['drinking-water', 'Drinking Water Quality Compliance', '12', false],
    ['rwqo', 'Resource Water Quality Objectives', '13', false],
    ['wrm', 'Water Resource Management', '14', false],
    ['water-quantity', 'Water Quantity Assessment', '15', false],
  ]],
  ['Platform', [
    ['admin', 'Administration', '', true],
  ]],
]

export const MONTHS = ['Oct 25', 'Nov 25', 'Dec 25', 'Jan 26', 'Feb 26', 'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26']

export function fscColor(v) {
  return v < 15 ? 'var(--d4)' : v < 30 ? 'var(--d3)' : v < 50 ? 'var(--d2)' : v < 70 ? 'var(--d1)' : 'var(--ok)'
}

export function riskColor(v) {
  return v >= 80 ? 'var(--d4)' : v >= 60 ? 'var(--d3)' : v >= 40 ? 'var(--d2)' : v >= 25 ? 'var(--d1)' : 'var(--ok)'
}

export function liveProvinces(predictions = []) {
  const byName = Object.fromEntries(predictions.map((item) => [item.province, item]))
  return PROV_META.map((meta) => {
    const row = byName[meta.name]
    const baseline = BASELINE_PROVINCES[meta.name] || {}
    const spi = Number(row?.bundle?.consensus_spi ?? baseline.spi ?? 0)
    const code = row?.bundle?.drought_code || baseline.d || '-'
    return {
      ...meta,
      d: code,
      spi,
      rain: Number(row?.inputs?.rainfall ?? 0),
      rain6: Number(row?.inputs?.seasonal_rainfall_6m ?? baseline.rain6 ?? 0),
      tmean: Number(row?.inputs?.mean_temperature ?? 0),
      pet: Number(row?.inputs?.pet ?? 0),
      humidity: Number(row?.inputs?.humidity ?? 0),
      rainAnomaly: baseline.rainAnomaly ?? 0,
      tempAnomaly: baseline.tempAnomaly ?? 0,
      soilDeficit: baseline.soilDeficit ?? 0,
      date: row?.observation_date || null,
      bundle: row?.bundle || null,
      inputs: row?.inputs || null,
      live: Boolean(row),
    }
  })
}
