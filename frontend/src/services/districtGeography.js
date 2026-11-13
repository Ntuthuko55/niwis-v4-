// Administrative membership reused from the existing hydrological dashboard.
// This is a boundary lookup, never a crosswalk for unlocated source records.
const groups = {
  'Eastern Cape': ['Alfred Nzo', 'Amathole', 'Buffalo City', 'Cacadu', 'Chris Hani', 'Joe Gqabi', 'Nelson Mandela Bay', 'OR Tambo'],
  'Free State': ['Fezile Dabi', 'Lejweleputswa', 'Mangaung', 'Thabo Mofutsanyane', 'Xhariep'],
  Gauteng: ['City of Johannesburg', 'City of Tshwane', 'Ekurhuleni', 'Sedibeng', 'West Rand'],
  'KwaZulu-Natal': ['Amajuba', 'eThekwini', 'iLembe', 'Sisonke', 'Ugu', 'uMgungundlovu', 'uMkhanyakude', 'uMzinyathi', 'uThukela', 'uThungulu', 'Zululand'],
  Limpopo: ['Capricorn', 'Mopani', 'Sekhukhune', 'Vhembe', 'Waterberg'],
  Mpumalanga: ['Ehlanzeni', 'Gert Sibande', 'Nkangala'],
  'North West': ['Bojanala', 'Dr Kenneth Kaunda', 'Dr Ruth Segomotsi Mompati', 'Ngaka Modiri Molema'],
  'Northern Cape': ['Frances Baard', 'John Taolo Gaetsewe', 'Namakwa', 'Pixley ka Seme', 'ZF Mgcawu'],
  'Western Cape': ['Cape Winelands', 'Central Karoo', 'City of Cape Town', 'Eden', 'Overberg', 'West Coast'],
}
const aliases = { sarahbaartman: 'cacadu', gardenroute: 'eden', harrygwala: 'sisonke', kingcetshwayo: 'uthungulu', greatersekhukhune: 'sekhukhune', siyanda: 'zfmgcawu' }
const key = name => String(name || '').toLowerCase().replace(/^city of /, '').replace(/[^a-z0-9]/g, '')
const membership = new Map(Object.entries(groups).flatMap(([province, names]) => names.map(name => [key(name), province])))
export function districtProvince(name) { const normalized = key(name); return membership.get(aliases[normalized] || normalized) || '' }
