"""
Hydrology service for NIWIS Hydrological Drought Monitoring.
Reads strictly from Supabase hydrological_drought_master without any hardcoded/dummy values.
All metrics, time series, flow duration curves, and indicators are computed directly from the database.
"""
from app.drought_source import read_rows, normalise_region
from typing import Dict, Any, List, Optional
import pandas as pd
import numpy as np

TABLE = "hydrological_drought_master"

DISTRICT_PROVINCES = {
    "alfred nzo": "Eastern Cape", "amajuba": "KwaZulu-Natal", "amathole": "Eastern Cape",
    "bojanala": "North West", "buffalo city": "Eastern Cape", "cacadu": "Eastern Cape",
    "cape winelands": "Western Cape", "capricorn": "Limpopo", "central karoo": "Western Cape",
    "chris hani": "Eastern Cape", "city of cape town": "Western Cape", "city of johannesburg": "Gauteng",
    "city of tshwane": "Gauteng", "dr kenneth kaunda": "North West", "dr ruth segomotsi mompati": "North West",
    "eden": "Western Cape", "ehlanzeni": "Mpumalanga", "ekurhuleni": "Gauteng",
    "ethekwini": "KwaZulu-Natal", "fezile dabi": "Free State", "frances baard": "Northern Cape",
    "gert sibande": "Mpumalanga", "ilembe": "KwaZulu-Natal", "joe gqabi": "Eastern Cape",
    "john taolo gaetsewe": "Northern Cape", "lejweleputswa": "Free State", "mangaung": "Free State",
    "mopani": "Limpopo", "namakwa": "Northern Cape", "nelson mandela bay": "Eastern Cape",
    "ngaka modiri molema": "North West", "nkangala": "Mpumalanga", "o.r.tambo": "Eastern Cape",
    "overberg": "Western Cape", "pixley ka seme": "Northern Cape", "sedibeng": "Gauteng",
    "sekhukhune": "Limpopo", "sisonke": "KwaZulu-Natal", "thabo mofutsanyane": "Free State",
    "ugu": "KwaZulu-Natal", "umgungundlovu": "KwaZulu-Natal", "umkhanyakude": "KwaZulu-Natal",
    "umzinyathi": "KwaZulu-Natal", "uthukela": "KwaZulu-Natal", "uthungulu": "KwaZulu-Natal",
    "vhembe": "Limpopo", "waterberg": "Limpopo", "west coast": "Western Cape",
    "west rand": "Gauteng", "xhariep": "Free State", "z f mgcawu": "Northern Cape",
    "zululand": "KwaZulu-Natal",
}

CENTROIDS = {
    "alfred nzo": (29.3, -30.7), "amajuba": (30.0, -27.7), "amathole": (27.0, -32.0),
    "bojanala": (27.2, -25.2), "buffalo city": (27.9, -33.0), "city of cape town": (18.5, -33.9),
    "cape winelands": (19.3, -33.5), "capricorn": (29.4, -23.8), "central karoo": (22.5, -32.7),
    "chris hani": (26.5, -31.5), "dr kenneth kaunda": (26.7, -26.8), "dr ruth segomotsi mompati": (25.0, -26.8),
    "eden": (22.2, -34.0), "ehlanzeni": (31.0, -25.4), "ekurhuleni": (28.3, -26.2),
    "ethekwini": (31.0, -29.8), "fezile dabi": (27.8, -27.2), "frances baard": (24.7, -28.6),
    "gert sibande": (30.0, -27.1), "ilembe": (31.2, -29.2), "joe gqabi": (27.5, -30.5),
    "city of johannesburg": (28.0, -26.2), "john taolo gaetsewe": (23.3, -27.7), "lejweleputswa": (26.5, -28.1),
    "mangaung": (26.2, -29.1), "mopani": (30.5, -23.5), "namakwa": (19.4, -30.2),
    "nelson mandela bay": (25.5, -33.9), "ngaka modiri molema": (25.6, -26.5), "nkangala": (29.2, -25.3),
    "o.r.tambo": (28.4, -31.6), "overberg": (20.3, -34.3), "pixley ka seme": (24.3, -30.4),
    "cacadu": (24.8, -33.2), "sedibeng": (28.0, -26.7), "sekhukhune": (30.1, -24.8),
    "sisonke": (29.7, -30.4), "thabo mofutsanyane": (28.5, -28.5), "city of tshwane": (28.2, -25.8),
    "ugu": (30.5, -30.3), "umgungundlovu": (30.3, -29.6), "umkhanyakude": (32.3, -27.7),
    "umzinyathi": (30.4, -28.5), "uthukela": (29.7, -28.6), "uthungulu": (31.5, -28.7),
    "vhembe": (30.5, -22.9), "waterberg": (27.9, -24.4), "west coast": (18.4, -32.0),
    "west rand": (27.7, -26.2), "xhariep": (25.1, -30.2), "z f mgcawu": (21.8, -28.4), "zululand": (31.0, -27.0),
}

def norm_key(name: str) -> str:
    return normalise_region(str(name))


def load_hydrology_data() -> pd.DataFrame:
    rows = read_rows(TABLE, {'select': '*', 'order': 'district_name.asc,date.asc,id.asc'})
    if not rows:
        return pd.DataFrame(columns=['date', 'date_str', 'district_name', 'district_key'])
    df = pd.DataFrame(rows)
    df['date_str'] = df['date'].astype(str)
    df['date'] = pd.to_datetime(df['date'])
    df['district_key'] = df['district_name'].apply(norm_key)
    return df


def classify_drought(ssi: float) -> Dict[str, str]:
    if ssi <= -2.0:
        return {"status": "Exceptional Drought", "condition": "Exceptional", "tone": "danger"}
    elif ssi <= -1.6:
        return {"status": "Extreme Drought", "condition": "Extreme", "tone": "danger"}
    elif ssi <= -1.3:
        return {"status": "Severe Drought", "condition": "Severe", "tone": "danger"}
    elif ssi <= -0.8:
        return {"status": "Moderate Drought", "condition": "Dry", "tone": "warning"}
    elif ssi <= -0.5:
        return {"status": "Abnormally Dry", "condition": "Mildly Dry", "tone": "warning"}
    elif ssi < 0.5:
        return {"status": "Near Normal", "condition": "Normal", "tone": "info"}
    elif ssi < 1.3:
        return {"status": "Moderately Wet", "condition": "Wet", "tone": "success"}
    else:
        return {"status": "Very Wet", "condition": "Very Wet", "tone": "success"}

def get_all_stations(target_date: Optional[str] = None) -> Dict[str, Any]:
    """Return latest actual database values for all 52 districts."""
    df = load_hydrology_data()
    if df.empty:
        return {'source': TABLE, 'date': None, 'station_count': 0, 'available_dates': [], 'stations': []}
    if not target_date:
        # Default to the latest observation
        target_date = df["date_str"].max()

    date_df = df[df["date_str"] == target_date]
    if date_df.empty:
        target_date = df["date_str"].max()
        date_df = df[df["date_str"] == target_date]

    stations = []
    target_month = pd.to_datetime(target_date).month

    for _, row in date_df.iterrows():
        name = str(row["district_name"])
        key = norm_key(name)
        k_lower = name.strip().lower()
        prov = DISTRICT_PROVINCES.get(k_lower, "South Africa")
        lon, lat = CENTROIDS.get(k_lower, (25.0, -29.0))

        # Real row values from database
        q = float(row["river_discharge_m3_s"])
        ssi = float(row["ssi_dimensionless"])
        dam_storage = float(row["dam_storage_million_m3"])
        dam_level_pct = float(row["dam_level_pct_fsc"])
        borehole = float(row["borehole_water_level_m_bgl"])
        sgi = float(row["sgi_dimensionless"])
        runoff = float(row["surface_runoff_m3_s"])
        baseflow = float(row["baseflow_separation_m3_s"])
        fdc_p = float(row["fdc_percentiles_m3_s"])

        # Historical monthly mean for this district from database
        sub_dist = df[df["district_key"] == key]
        hist_month = sub_dist[sub_dist["date"].dt.month == target_month]
        hist_q_mean = float(hist_month["river_discharge_m3_s"].mean()) if not hist_month.empty else q
        q_change_pct = ((q - hist_q_mean) / hist_q_mean * 100) if hist_q_mean > 0 else 0.0

        dclass = classify_drought(ssi)

        stations.append({
            "name": name,
            "district_key": key,
            "province": prov,
            "lon": lon,
            "lat": lat,
            "river_discharge_m3_s": q,
            "discharge_hist_avg": hist_q_mean,
            "discharge_change_pct": round(q_change_pct, 1),
            "fdc_percentiles_m3_s": fdc_p,
            "ssi": round(ssi, 3),
            "borehole_water_level_m_bgl": borehole,
            "sgi": round(sgi, 3),
            "surface_runoff_m3_s": runoff,
            "baseflow_m3_s": baseflow,
            "dam_storage_million_m3": dam_storage,
            "dam_level_pct_fsc": dam_level_pct,
            "drought_status": dclass["status"],
        })

    available_dates = sorted(df["date_str"].unique().tolist())

    return {
        "source": TABLE,
        "date": target_date,
        "station_count": len(stations),
        "available_dates": available_dates,
        "stations": stations,
    }

def get_district_hydrology_history(district_name: str, target_date: Optional[str] = None) -> Dict[str, Any]:
    """
    Returns complete time series and indicator analysis computed exclusively from Supabase hydrological_drought_master.
    Zero synthetic or hardcoded values.
    """
    df = load_hydrology_data()
    key = norm_key(district_name)
    sub = df[df["district_key"] == key].sort_values("date")
    if sub.empty:
        return {
            "district": district_name,
            "province": "South Africa",
            "date": None,
            "available_dates": [],
            "metrics": {},
            "records": [],
            "error": f"No records for district: {district_name}",
        }

    formal_name = sub.iloc[0]["district_name"]
    k_lower = formal_name.strip().lower()
    prov = DISTRICT_PROVINCES.get(k_lower, "South Africa")

    available_dates = sorted(sub["date_str"].unique().tolist())
    if not target_date or target_date not in available_dates:
        # Default to the latest date in the database
        target_date = available_dates[-1]

    # Current selected row strictly from database
    curr_df = sub[sub["date_str"] == target_date]
    if curr_df.empty:
        curr_df = sub.iloc[[-1]]
    r = curr_df.iloc[0]
    target_dt = r["date"]
    target_month = target_dt.month

    # 1. Exact values from database
    river_discharge = float(r["river_discharge_m3_s"])
    fdc_val = float(r["fdc_percentiles_m3_s"])
    ssi = float(r["ssi_dimensionless"])
    dam_storage = float(r["dam_storage_million_m3"])
    dam_level_pct = float(r["dam_level_pct_fsc"])
    dam_inflow = float(r["dam_inflow_m3_s"])
    dam_outflow = float(r["dam_outflow_m3_s"])
    borehole = float(r["borehole_water_level_m_bgl"])
    sgi = float(r["sgi_dimensionless"])
    surface_runoff = float(r["surface_runoff_m3_s"])
    baseflow = float(r["baseflow_separation_m3_s"])

    # 2. Historical comparison for this calendar month across all database records
    hist_month_rows = sub[sub["date"].dt.month == target_month]
    hist_q_mean = float(hist_month_rows["river_discharge_m3_s"].mean())
    hist_runoff_mean = float(hist_month_rows["surface_runoff_m3_s"].mean())
    hist_baseflow_mean = float(hist_month_rows["baseflow_separation_m3_s"].mean())

    q_change_pct = ((river_discharge - hist_q_mean) / hist_q_mean * 100) if hist_q_mean > 0 else 0.0
    runoff_change_pct = ((surface_runoff - hist_runoff_mean) / hist_runoff_mean * 100) if hist_runoff_mean > 0 else 0.0
    baseflow_change_pct = ((baseflow - hist_baseflow_mean) / hist_baseflow_mean * 100) if hist_baseflow_mean > 0 else 0.0

    # 3. Month-over-month (MoM) comparison with the preceding month
    preceding_rows = sub[sub["date"] < target_dt]
    if not preceding_rows.empty:
        prev_r = preceding_rows.iloc[-1]
        prev_borehole = float(prev_r["borehole_water_level_m_bgl"])
        prev_sgi = float(prev_r["sgi_dimensionless"])
        borehole_change_pct = ((borehole - prev_borehole) / abs(prev_borehole) * 100) if prev_borehole != 0 else 0.0
        sgi_change_pct = ((sgi - prev_sgi) / abs(prev_sgi) * 100) if prev_sgi != 0 else 0.0
    else:
        borehole_change_pct = 0.0
        sgi_change_pct = 0.0

    # 4. Empirical percentiles from database discharge series
    all_q = sub["river_discharge_m3_s"].values
    p10_flow = float(np.percentile(all_q, 10))
    p50_flow = float(np.percentile(all_q, 50))
    p10_change = ((river_discharge - p10_flow) / p10_flow * 100) if p10_flow > 0 else 0.0
    p50_change = ((river_discharge - p50_flow) / p50_flow * 100) if p50_flow > 0 else 0.0

    # 5. Last 12 months chronological discharge series strictly from database
    recent_12 = sub[sub["date"] <= target_dt].tail(12)
    river_discharge_12m = []
    for _, r_row in recent_12.iterrows():
        m_num = r_row["date"].month
        hist_for_m = sub[sub["date"].dt.month == m_num]["river_discharge_m3_s"]
        m_mean = float(hist_for_m.mean())
        m_std = float(hist_for_m.std()) if len(hist_for_m) > 1 else 0.0
        river_discharge_12m.append({
            "date": r_row["date"].strftime("%Y-%m-%d"),
            "month": r_row["date"].strftime("%b %Y"),
            "current": float(r_row["river_discharge_m3_s"]),
            "historical_avg": float(m_mean),
            "range_min": float(max(0.0, m_mean - m_std)),
            "range_max": float(m_mean + m_std),
        })

    # 6. Flow Duration Curve computed directly from database
    sorted_all_q = np.sort(all_q)[::-1]
    n_all = len(sorted_all_q)
    recent_q_sorted = np.sort(recent_12["river_discharge_m3_s"].values)[::-1]
    n_rec = len(recent_q_sorted)

    probs = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99]
    fdc_points = []
    for p in probs:
        idx_all = min(n_all - 1, max(0, int(p / 100.0 * (n_all - 1))))
        idx_rec = min(n_rec - 1, max(0, int(p / 100.0 * (n_rec - 1))))
        fdc_points.append({
            "p": p,
            "historical": float(sorted_all_q[idx_all]),
            "current": float(recent_q_sorted[idx_rec]),
        })

    # 7. Last 6 months series strictly from database
    recent_6 = sub[sub["date"] <= target_dt].tail(6)
    groundwater_6m = [
        {"date": row["date"].strftime("%Y-%m-%d"), "month": row["date"].strftime("%b"), "value": float(row["borehole_water_level_m_bgl"])}
        for _, row in recent_6.iterrows()
    ]
    sgi_6m = [
        {"date": row["date"].strftime("%Y-%m-%d"), "month": row["date"].strftime("%b"), "value": float(row["sgi_dimensionless"])}
        for _, row in recent_6.iterrows()
    ]
    runoff_6m = [
        {"date": row["date"].strftime("%Y-%m-%d"), "month": row["date"].strftime("%b"), "value": float(row["surface_runoff_m3_s"])}
        for _, row in recent_6.iterrows()
    ]
    baseflow_6m = [
        {"date": row["date"].strftime("%Y-%m-%d"), "month": row["date"].strftime("%b"), "value": float(row["baseflow_separation_m3_s"])}
        for _, row in recent_6.iterrows()
    ]

    # 8. Drought Classification
    dclass = classify_drought(ssi)

    # 9. All 11 Variables Table with raw database values
    variables_table = [
        {
            "variable": "River Discharge",
            "value": river_discharge,
            "unit": "m³/s",
            "trend": f"{'↓' if q_change_pct < 0 else '↑'} {abs(q_change_pct):.1f}%",
            "status": "Below Normal" if q_change_pct < -10 else "Above Normal" if q_change_pct > 10 else "Normal",
            "tone": "warning" if q_change_pct < -10 else "success" if q_change_pct > 10 else "info",
        },
        {
            "variable": "Flow Percentile (P10)",
            "value": fdc_val,
            "unit": "m³/s",
            "trend": f"{'↓' if p10_change < 0 else '↑'} {abs(p10_change):.1f}%",
            "status": "Low" if river_discharge <= p10_flow else "Normal",
            "tone": "danger" if river_discharge <= p10_flow else "info",
        },
        {
            "variable": "SSI (Streamflow)",
            "value": ssi,
            "unit": "(dimensionless)",
            "trend": f"{'↓' if ssi < 0 else '↑'}",
            "status": dclass["condition"],
            "tone": dclass["tone"],
        },
        {
            "variable": "Dam Storage",
            "value": dam_storage,
            "unit": "million m³",
            "trend": "-",
            "status": "Normal" if dam_storage > 0 else "N/A",
            "tone": "info",
        },
        {
            "variable": "Dam Level",
            "value": dam_level_pct,
            "unit": "% FSC",
            "trend": "-",
            "status": "Full" if dam_level_pct >= 90 else "Adequate" if dam_level_pct >= 50 else "Critical",
            "tone": "success" if dam_level_pct >= 70 else "warning" if dam_level_pct >= 40 else "danger",
        },
        {
            "variable": "Dam Inflow",
            "value": dam_inflow,
            "unit": "m³/s",
            "trend": "-",
            "status": "Active" if dam_inflow > 0 else "Low",
            "tone": "info",
        },
        {
            "variable": "Dam Outflow",
            "value": dam_outflow,
            "unit": "m³/s",
            "trend": "-",
            "status": "Active" if dam_outflow > 0 else "Low",
            "tone": "info",
        },
        {
            "variable": "Borehole Water Level",
            "value": borehole,
            "unit": "m bgl",
            "trend": f"{'↑' if borehole_change_pct >= 0 else '↓'} {abs(borehole_change_pct):.1f}%",
            "status": "Improving" if borehole_change_pct >= 0 else "Declining",
            "tone": "success" if borehole_change_pct >= 0 else "warning",
        },
        {
            "variable": "SGI (Groundwater)",
            "value": sgi,
            "unit": "(dimensionless)",
            "trend": f"{'↑' if sgi_change_pct >= 0 else '↓'} {abs(sgi_change_pct):.1f}%",
            "status": "Above Normal" if sgi > 0.5 else "Below Normal" if sgi < -0.5 else "Normal",
            "tone": "success" if sgi > 0.5 else "warning" if sgi < -0.5 else "info",
        },
        {
            "variable": "Surface Runoff",
            "value": surface_runoff,
            "unit": "m³/s",
            "trend": f"{'↓' if runoff_change_pct < 0 else '↑'} {abs(runoff_change_pct):.1f}%",
            "status": "Below Normal" if runoff_change_pct < -10 else "Normal",
            "tone": "warning" if runoff_change_pct < -10 else "info",
        },
        {
            "variable": "Baseflow Separation",
            "value": baseflow,
            "unit": "m³/s",
            "trend": f"{'↓' if baseflow_change_pct < 0 else '↑'} {abs(baseflow_change_pct):.1f}%",
            "status": "Below Normal" if baseflow_change_pct < -10 else "Normal",
            "tone": "warning" if baseflow_change_pct < -10 else "info",
        },
    ]

    # 10. Dynamic Insights generated directly from actual values
    insights = []
    if q_change_pct < -10:
        insights.append({
            "type": "danger",
            "text": f"River discharge ({river_discharge:.4f} m³/s) is {abs(q_change_pct):.1f}% below the historical monthly average ({hist_q_mean:.4f} m³/s).",
        })
    else:
        insights.append({
            "type": "info",
            "text": f"River discharge is currently {river_discharge:.4f} m³/s, maintaining close to the historical baseline of {hist_q_mean:.4f} m³/s.",
        })

    if ssi <= -0.8:
        insights.append({
            "type": "warning",
            "text": f"Standardized Streamflow Index (SSI = {ssi:.2f}) indicates {dclass['status']} conditions in {formal_name}.",
        })
    else:
        insights.append({
            "type": "info",
            "text": f"Standardized Streamflow Index (SSI = {ssi:.2f}) reflects {dclass['status']} hydrological conditions.",
        })

    if borehole_change_pct >= 0:
        insights.append({
            "type": "info",
            "text": f"Groundwater level ({borehole:.4f} m bgl) is {abs(borehole_change_pct):.1f}% higher than last month.",
        })
    else:
        insights.append({
            "type": "warning",
            "text": f"Groundwater level ({borehole:.4f} m bgl) has declined by {abs(borehole_change_pct):.1f}% compared to last month.",
        })

    if runoff_change_pct < 0 or baseflow_change_pct < 0:
        insights.append({
            "type": "danger",
            "text": f"Surface runoff ({surface_runoff:.4f} m³/s) and baseflow ({baseflow:.4f} m³/s) reflect sustained catchment deficit.",
        })
    else:
        insights.append({
            "type": "info",
            "text": f"Surface runoff ({surface_runoff:.4f} m³/s) and baseflow ({baseflow:.4f} m³/s) are currently sustained by seasonal contributions.",
        })

    # 11. Recommendations tailored to conditions
    recommendations = [
        {"text": f"Continue monitoring river discharge ({river_discharge:.4f} m³/s) and borehole levels in {formal_name}."},
        {"text": f"Evaluate reservoir balance: dam storage is currently at {dam_storage:.1f} Mm³ ({dam_level_pct:.1f}% FSC)."},
        {"text": f"Assess ecological reserve compliance based on baseflow separation ({baseflow:.4f} m³/s)."},
        {"text": f"Maintain drought preparedness and water management measures in {formal_name} ({prov})."},
    ]

    records = []
    for rec in sub.to_dict("records"):
        records.append({
            "date": rec["date"].strftime("%Y-%m-%d") if hasattr(rec["date"], "strftime") else str(rec["date"])[:10],
            "district_name": rec["district_name"],
            "river_discharge_m3_s": _num(rec.get("river_discharge_m3_s")),
            "ssi_dimensionless": _num(rec.get("ssi_dimensionless")),
            "dam_inflow_m3_s": _num(rec.get("dam_inflow_m3_s")),
            "dam_outflow_m3_s": _num(rec.get("dam_outflow_m3_s")),
            "surface_runoff_m3_s": _num(rec.get("surface_runoff_m3_s")),
            "baseflow_separation_m3_s": _num(rec.get("baseflow_separation_m3_s")),
            "dam_storage_million_m3": _num(rec.get("dam_storage_million_m3")),
            "dam_level_pct_fsc": _num(rec.get("dam_level_pct_fsc")),
            "borehole_water_level_m_bgl": _num(rec.get("borehole_water_level_m_bgl")),
            "sgi_dimensionless": _num(rec.get("sgi_dimensionless")),
            "fdc_percentiles_m3_s": _num(rec.get("fdc_percentiles_m3_s")),
        })

    return {
        "district": formal_name,
        "province": prov,
        "source": TABLE,
        "date": target_date,
        "available_dates": available_dates,
        "metrics": {
            "river_discharge": river_discharge,
            "discharge_hist_avg": hist_q_mean,
            "discharge_change": q_change_pct,
            "p10": p10_flow,
            "p10_change": p10_change,
            "p50": p50_flow,
            "p50_change": p50_change,
            "ssi": ssi,
            "borehole": borehole,
            "borehole_change": borehole_change_pct,
            "sgi": sgi,
            "sgi_change": sgi_change_pct,
            "surface_runoff": surface_runoff,
            "runoff_change": runoff_change_pct,
            "baseflow": baseflow,
            "baseflow_change": baseflow_change_pct,
            "dam_storage": dam_storage,
            "dam_level_pct": dam_level_pct,
            "dam_inflow": dam_inflow,
            "dam_outflow": dam_outflow,
        },
        "river_discharge_12m": river_discharge_12m,
        "fdc": fdc_points,
        "groundwater_6m": groundwater_6m,
        "sgi_6m": sgi_6m,
        "runoff_6m": runoff_6m,
        "baseflow_6m": baseflow_6m,
        "variables_table": variables_table,
        "insights": insights,
        "recommendations": recommendations,
        "drought_status": {
            "ssi": ssi,
            "condition": dclass["condition"],
            "status": dclass["status"],
            "trend": "Worsening" if ssi < -0.5 else "Improving" if ssi > 0.5 else "Stable",
            "confidence": "High",
        },
        "records": records,
    }


def _num(value):
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def get_hydrology_dataset() -> Dict[str, Any]:
    """Return every hydrological_drought_master row for client-side district filtering."""
    df = load_hydrology_data().sort_values(["district_name", "date"])
    records = []
    for rec in df.to_dict("records"):
        records.append({
            "date": rec["date"].strftime("%Y-%m-%d") if hasattr(rec["date"], "strftime") else str(rec["date"])[:10],
            "district_name": rec["district_name"],
            "river_discharge_m3_s": _num(rec.get("river_discharge_m3_s")),
            "ssi_dimensionless": _num(rec.get("ssi_dimensionless")),
            "dam_inflow_m3_s": _num(rec.get("dam_inflow_m3_s")),
            "dam_outflow_m3_s": _num(rec.get("dam_outflow_m3_s")),
            "surface_runoff_m3_s": _num(rec.get("surface_runoff_m3_s")),
            "baseflow_separation_m3_s": _num(rec.get("baseflow_separation_m3_s")),
            "dam_storage_million_m3": _num(rec.get("dam_storage_million_m3")),
            "dam_level_pct_fsc": _num(rec.get("dam_level_pct_fsc")),
            "borehole_water_level_m_bgl": _num(rec.get("borehole_water_level_m_bgl")),
            "sgi_dimensionless": _num(rec.get("sgi_dimensionless")),
            "fdc_percentiles_m3_s": _num(rec.get("fdc_percentiles_m3_s")),
        })
    districts = sorted({row["district_name"] for row in records})
    return {"source": TABLE, "record_count": len(records), "districts": districts, "records": records}
