import pandas as pd

df = pd.read_csv("csv's/hydrology.csv")

# Tshwane exact match
tsh_exact = df[df['district_name'] == 'City of Tshwane']
tsh_ci = df[df['district_name'].str.lower() == 'city of tshwane']
print(f"Exact match 'City of Tshwane': {len(tsh_exact)}")
print(f"Case-insensitive match: {len(tsh_ci)}")

# First 10 districts
print("\nFirst 10 districts (sorted):")
for d in sorted(df['district_name'].unique())[:10]:
    print(f"  {repr(d)}")

print(f"\nTotal districts: {df['district_name'].nunique()}")
print(f"Total rows: {len(df)}")
print(f"Date range: {df['date'].min()} to {df['date'].max()}")
