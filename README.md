# NIWIS v4

National Integrated Water Information System (NIWIS) is a dashboard for exploring South African climate, drought, satellite, water-storage, and time-series data.

## Run locally

From the project root, create a dedicated backend environment and install its dependencies:

```powershell
python -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

Start the backend from the project root:

```powershell
.\backend\start.ps1
```

Alternatively, start it directly from the `backend` directory:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

These commands use `backend\.venv` explicitly. A bare `uvicorn` command can use
the global Python installation, which may contain incompatible dependencies. If startup
reports a Pydantic/core version mismatch, reinstall the dependencies in the backend
environment with the installation command above. The application import path is
`app.main:app` when running from `backend`.

In a second terminal, start the frontend:

```powershell
cd frontend
npm install
npm run dev
```

Open the local Vite URL displayed in the terminal. The frontend proxies API requests to `http://localhost:8000`.

## Project layout

- `frontend/` - React and Vite dashboard
- `backend/` - FastAPI services and analysis pipelines
- `csv's/` - local climate, hydrology, and satellite input data
- `South_Africa_Provinces/` - provincial source datasets

The current file connections and source dependencies are documented in the
[system flow report](output/deployment-audit/System-Flow.md). The
[cleanup report](output/deployment-audit/Cleanup-Report.md) records removed files
and the location of the recovery archive.

The large reservoir reference CSV is stored using Git LFS. Install Git LFS and
run `git lfs pull` after cloning if the dataset has not downloaded automatically.

## Notes

Local environment files, development logs, virtual environments, and generated build output are excluded from version control.

The climate dashboard and its six indicator sections read Supabase through the
backend. The `climate/` CSV files are retained for source comparison only. Set `SUPABASE_URL` and
the server-only `SUPABASE_SERVICE_ROLE_KEY` (or an anon key with table read access)
in `backend/.env`. `NIWIS_SUPABASE_TABLES_MODULE_2` lists the six tables in section
order 4.1–4.6; the current streamflow table includes a space before `_master`.
See `backend/.env.example` for the exact names. Restart the backend after changing
configuration. Database failures appear as errors, with no CSV fallback.

Climate queries retrieve all pages and cache observations and derived summaries
for `NIWIS_SUPABASE_CACHE_TTL` seconds (default 900). The national overview and
district views load all six indicator tables, including daily temperature,
evaporation, and irrigation observations. Daily database reads use bounded
two-week windows without expensive full-table count scans; annual tables use exact
pagination checks.
The dashboard shows available years and flags selections shorter than 30 years
and records that do not span the 1981–2010 temperature baseline.

The Groundwater Reserve Assessment module reads the three section 11 files in
`Groundwater Reserve Assessment/`. It keeps dynamic and static reserve as
supplied indicators and derives a signed storage change and reserve balance
from water-table depth, aquifer area, the supplied storage coefficient and
abstraction. The ecological reserve is reported as unavailable because it is
not present in the supplied files.

Section 11 and section 12 service tests can be run with:

```powershell
.\.venv\Scripts\python.exe -m unittest test_groundwater_reserve_service.py test_water_quality_service.py
```

The Water Quality Monitoring Network module reads the four section 12 files in
`water Quality Monitor/`. Physical, chemical, biological and SANSA proxy
observations remain separate, with supplied units and coverage shown directly;
no regulatory quality classification is inferred without threshold metadata.

Run the climate reader/API regression checks from `backend`:

```powershell
.\.venv\Scripts\python.exe -m unittest test_climate_service
```

The live database value check (including national/district agreement) is:

```powershell
.\.venv\Scripts\python.exe verify_climate_values.py
```

Compare the database source with the local CSV copies:

```powershell
.\.venv\Scripts\python.exe compare_climate_sources.py
```

Vegetation dashboard loading improvements and measured checks are documented in
[Vegetation loading improvements](output/dashboard-performance/Vegetation-Loading-Improvements.md).

Rainfall Status Monitoring uses independent map/daily requests and shared monthly
summaries. See [Rainfall loading improvements](output/dashboard-performance/Rainfall-Loading-Improvements.md)
for measured timings and validation.

Groundwater Level Monitoring Network uses cached monthly summaries and independent
map/daily loading while preserving sparse observation dates. See
[Groundwater loading improvements](output/dashboard-performance/Groundwater-Loading-Improvements.md).
