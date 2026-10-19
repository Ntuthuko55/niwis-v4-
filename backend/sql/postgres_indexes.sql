-- Prepared for the PostgreSQL migration. This file is not executed by the
-- application. Apply it only after reviewing the deployed table names and
-- obtaining the required database-change approval. CONCURRENTLY avoids blocking
-- readers, but each statement must run outside an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS niwis_daily_climate_v2_province_date_idx
    ON public.niwis_daily_climate_v2 (province, date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS meteorological_drought_master_district_date_idx
    ON public.meteorological_drought_master (district_name, date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS meteorological_drought_master_date_district_idx
    ON public.meteorological_drought_master (date, district_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS hydrological_drought_master_district_date_idx
    ON public.hydrological_drought_master (district_name, date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hydrological_drought_master_date_district_idx
    ON public.hydrological_drought_master (date, district_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS satellite_remote_sensing_district_date_idx
    ON public.satellite_remote_sensing (district_name, date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS satellite_remote_sensing_date_district_idx
    ON public.satellite_remote_sensing (date, district_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS climate_temperature_district_date_idx
    ON public."4_1_temperature_change_master" ("District_Name", "Date");
CREATE INDEX CONCURRENTLY IF NOT EXISTS climate_spells_district_year_idx
    ON public."4_2_wet_dry_spells_master" ("District_Name", "Year");
CREATE INDEX CONCURRENTLY IF NOT EXISTS climate_rainfall_district_year_idx
    ON public."4_3_mean_annual_precipitation_master" ("District_Name", "Year");
CREATE INDEX CONCURRENTLY IF NOT EXISTS climate_evaporation_district_date_idx
    ON public."4_4_potential_evaporation_daily_master" ("District_Name", "Date");
CREATE INDEX CONCURRENTLY IF NOT EXISTS climate_irrigation_district_date_idx
    ON public."4_5_irrigation_demand_daily_master" ("District_Name", "Date");
CREATE INDEX CONCURRENTLY IF NOT EXISTS climate_streamflow_district_year_idx
    ON public."4_6_streamflow_and_climate_linkage_annual_master" ("District_Name", "Year");
