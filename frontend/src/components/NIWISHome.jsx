import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, ChartNoAxesCombined, Check, ChevronRight, CloudRain, CloudSun, Compass, Database, Droplets, FlaskConical, Globe2, Layers3, Leaf, MapPinned, Menu, Network, ShieldCheck, Waves, X } from 'lucide-react'
import '../niwis/niwis-home.css'

const dashboards = [
  { number: '01', title: 'Drought monitoring', description: 'Explore rainfall, vegetation and water indicators to understand drought conditions.', href: '/drought', category: 'climate', icon: CloudSun, tags: ['Drought indices', 'District maps'], featured: true },
  { number: '02', title: 'Climate dashboard', description: 'Put temperature, rainfall and changing climate patterns into perspective.', href: '/climate', category: 'climate', icon: CloudRain, tags: ['Climate trends', 'Historical records'], featured: true },
  { number: '03', title: 'Vegetation condition', description: 'Explore satellite vegetation indices alongside their climate drivers.', href: '/vegetation', category: 'climate', icon: Leaf, tags: ['Vegetation', 'Satellite indicators'] },
  { number: '04', title: 'Rainfall status', description: 'Compare rainfall observations, satellite estimates and rainfall indices.', href: '/rainfall', category: 'climate', icon: CloudRain, tags: ['Rainfall', 'Seasonal patterns'] },
  { number: '05', title: 'Runoff status', description: 'Follow catchment response, runoff indicators and water-balance trends.', href: '/runoff', category: 'climate', icon: Waves, tags: ['Catchments', 'Runoff'] },
  { number: '06', title: 'Surface water network', description: 'Connect river observations with catchment characteristics and earth observation.', href: '/surface-water', category: 'resources', icon: Network, tags: ['Rivers', 'Catchments'] },
  { number: '07', title: 'Groundwater monitoring', description: 'Explore borehole levels, recharge and aquifer conditions beneath the surface.', href: '/groundwater', category: 'resources', icon: Layers3, tags: ['Borehole levels', 'Aquifers'], featured: true },
  { number: '08', title: 'Groundwater reserve', description: 'Examine reserve indicators, abstraction and changes in groundwater storage.', href: '/groundwater-reserve', category: 'resources', icon: Layers3, tags: ['Reserves', 'Abstraction'] },
  { number: '09', title: 'Water quality monitoring', description: 'Examine physical, chemical and biological observations across districts.', href: '/water-quality', category: 'quality', icon: FlaskConical, tags: ['Quality indicators', 'Source observations'], featured: true },
  { number: '10', title: 'Dams & reservoirs', description: 'Understand stored water through reservoir levels, releases and catchment conditions.', href: '/reservoirs', category: 'resources', icon: Waves, tags: ['Storage', 'Reservoir operations'], featured: true },
  { number: '11', title: 'Wastewater compliance', description: 'Review effluent quality, treatment works operations and weather conditions.', href: '/wastewater-compliance', category: 'quality', icon: FlaskConical, tags: ['Effluent quality', 'Treatment works'] },
  { number: '12', title: 'Drinking water compliance', description: 'Review drinking-water measurements, reported flags and source target values.', href: '/drinking-water-compliance', category: 'quality', icon: ShieldCheck, tags: ['Drinking water', 'Reported compliance'] },
  { number: '13', title: 'Water quality objectives', description: 'Explore ecological, chemical and hydrological resource quality objectives.', href: '/resource-water-quality-objectives', category: 'quality', icon: FlaskConical, tags: ['Resource objectives', 'Ecology'] },
  { number: '14', title: 'Water resource management', description: 'Explore annual resource indicators and Strategic Water Source Area observations.', href: '/water-resource-management', category: 'resources', icon: MapPinned, tags: ['Water resources', 'Source areas'] },
  { number: '15', title: 'Water quantity assessment', description: 'Explore monthly transfer rates and the source national water balance.', href: '/water-quantity-assessment', category: 'resources', icon: ChartNoAxesCombined, tags: ['Transfers', 'Water balance'] },
  { number: '16', title: 'Water services', description: 'Explore household access, infrastructure operations and supply reliability coverage.', href: '/water-services', category: 'quality', icon: Droplets, tags: ['Access & supply', 'Infrastructure'], featured: true },
  { number: '17', title: 'Water tariffs & costs', description: 'Compare available municipal tariffs, raw-water tariffs and water-quality costs.', href: '/water-tariffs-and-quality-costs', category: 'quality', icon: ChartNoAxesCombined, tags: ['Municipal tariffs', 'Quality costs'] },
]

const filters = [
  ['featured', 'Featured'], ['climate', 'Climate & environment'],
  ['resources', 'Water resources'], ['quality', 'Quality & services'], ['all', 'All dashboards'],
]

function DashboardCard({ dashboard }) {
  const Icon = dashboard.icon
  return <a className={`nh-dashboard-card nh-category-${dashboard.category}`} href={dashboard.href}>
    <div className="nh-card-top"><span className="nh-card-icon"><Icon size={23} strokeWidth={1.6} aria-hidden="true" /></span><span className="nh-card-number">{dashboard.number}</span></div>
    <h3>{dashboard.title}</h3>
    <p>{dashboard.description}</p>
    <div className="nh-card-tags">{dashboard.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
    <div className="nh-card-link">Open dashboard <ArrowUpRight size={18} aria-hidden="true" /></div>
  </a>
}

export default function NIWISHome() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [filter, setFilter] = useState('featured')
  const menuButton = useRef(null)
  const header = useRef(null)
  const visibleDashboards = dashboards.filter(dashboard => filter === 'all' || (filter === 'featured' ? dashboard.featured : dashboard.category === filter))

  useEffect(() => {
    document.title = 'NIWIS | National Integrated Water Information System'
    const closeMenu = event => {
      if (event.key === 'Escape' && menuOpen) { setMenuOpen(false); menuButton.current?.focus() }
    }
    const closeOutside = event => { if (!header.current?.contains(event.target)) setMenuOpen(false) }
    document.addEventListener('keydown', closeMenu)
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('keydown', closeMenu); document.removeEventListener('pointerdown', closeOutside) }
  }, [menuOpen])

  return <div className="nh-home">
    <a className="nh-skip" href="#home-main">Skip to content</a>
    <div className="nh-government-strip"><div className="nh-container"><span>DEPARTMENT OF WATER AND SANITATION</span><span><Globe2 size={12} aria-hidden="true" /> Republic of South Africa</span></div></div>
    <header className="nh-header" ref={header}>
      <div className="nh-container nh-header-inner">
        <a className="nh-brand" href="/" aria-label="NIWIS home">
          <img src="/Water-and-Sanitation.png" width="756" height="426" alt="Department of Water and Sanitation, Republic of South Africa" />
          <span className="nh-brand-divider" aria-hidden="true" />
          <span className="nh-wordmark"><strong>NIWIS<span>.</span></strong><small>National Integrated Water<br />Information System</small></span>
        </a>
        <button className="nh-menu-toggle" type="button" ref={menuButton} onClick={() => setMenuOpen(open => !open)} aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="home-navigation">{menuOpen ? <X size={23} /> : <Menu size={23} />}</button>
        <nav id="home-navigation" className={`nh-navigation${menuOpen ? ' is-open' : ''}`} aria-label="Main navigation" onClick={() => setMenuOpen(false)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== menuButton.current) setMenuOpen(false) }}>
          <a className="nh-nav-home" href="/" aria-current="page">Home</a>
          <a href="#dashboards">Dashboards</a>
          <a href="#about">About NIWIS</a>
          <a href="#getting-started">Getting started</a>
          <a className="nh-button nh-button-dark nh-nav-cta" href="/drought">Enter the portal <ArrowUpRight size={17} aria-hidden="true" /></a>
        </nav>
      </div>
    </header>

    <main id="home-main" tabIndex={-1}>
      <section className="nh-hero" aria-labelledby="home-title">
        <div className="nh-hero-contours" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="nh-container nh-hero-grid">
          <div className="nh-hero-copy">
            <div className="nh-eyebrow nh-eyebrow-light"><span /> WATER INFORMATION. CONNECTED.</div>
            <h1 id="home-title">One connected view<br />of South Africa’s<br /><em>water.</em></h1>
            <p>From rainfall to reservoirs, from groundwater to the communities it serves. Explore the information behind a more water-resilient South Africa.</p>
            <div className="nh-hero-actions"><a className="nh-button nh-button-teal" href="/drought">Explore dashboards <ArrowRight size={18} aria-hidden="true" /></a><a className="nh-button nh-button-outline" href="#about">Discover NIWIS <ArrowDown size={17} aria-hidden="true" /></a></div>
            <div className="nh-hero-footnote"><Compass size={17} strokeWidth={1.5} aria-hidden="true" /><span>National perspective. Local understanding.</span></div>
          </div>
          <figure className="nh-map-figure">
            <div className="nh-map-heading"><div><span className="nh-mini-label">OUR SHARED RESOURCE</span><h2>A national perspective</h2></div><span className="nh-map-country">ZA <ArrowUpRight size={14} aria-hidden="true" /></span></div>
            <div className="nh-map-stage"><div className="nh-map-orbit" aria-hidden="true" /><img className="nh-national-map" src="/niwis-national-map.svg" width="720" height="600" alt="Geographic overview of South Africa showing district boundaries and the nine provinces. No monitoring values are shown." fetchpriority="high" />
              <div className="nh-map-note"><span><Layers3 size={19} strokeWidth={1.5} aria-hidden="true" /></span><div><strong>See the bigger picture</strong><small>Explore water, climate and services</small></div></div>
            </div>
            <figcaption><span><i aria-hidden="true" /> District boundaries · geographic reference</span><a href="/drought" aria-label="Explore maps in the drought dashboard">Explore maps <ArrowRight size={14} aria-hidden="true" /></a></figcaption>
          </figure>
        </div>
      </section>

      <section className="nh-scope" aria-label="Platform scope">
        <div className="nh-container nh-scope-grid"><div className="nh-scope-intro"><span className="nh-eyebrow">CONNECTED BY PURPOSE</span><p>A wider view.<br /><strong>A clearer understanding.</strong></p></div><div className="nh-scope-stat"><strong>{dashboards.length}<span> dashboards</span></strong><p>Across the water information landscape</p></div><div className="nh-scope-stat"><strong>09<span> provinces</span></strong><p>A shared South African perspective</p></div><div className="nh-scope-stat"><strong>52<span> district map areas</span></strong><p>Data availability varies by source</p></div></div>
      </section>

      <section className="nh-directory nh-section" id="dashboards" aria-labelledby="dashboards-title">
        <div className="nh-container">
          <div className="nh-section-heading"><div><span className="nh-eyebrow">EXPLORE THE PLATFORM</span><h2 id="dashboards-title">Start with what matters to you.</h2></div><p>Find the right perspective on water.<br />Each dashboard brings a different part of the picture into focus.</p></div>
          <div className="nh-directory-toolbar"><div className="nh-filters" role="group" aria-label="Filter dashboards by topic">{filters.map(([value, label]) => <button key={value} type="button" className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} aria-controls="home-dashboard-grid" onClick={() => setFilter(value)}>{label}{value === 'all' && <span>{dashboards.length}</span>}</button>)}</div><span className="nh-result-count" role="status">{visibleDashboards.length} dashboards</span></div>
          <div id="home-dashboard-grid" className="nh-dashboard-grid">{visibleDashboards.map(dashboard => <DashboardCard key={dashboard.href} dashboard={dashboard} />)}</div>
          <p className="nh-directory-note"><Database size={14} aria-hidden="true" /> Available periods, source coverage and data status are shown within each dashboard.</p>
        </div>
      </section>

      <section className="nh-about" id="about" aria-labelledby="about-title">
        <div className="nh-container nh-about-grid">
          <div className="nh-about-copy"><span className="nh-eyebrow nh-eyebrow-light">ABOUT NIWIS</span><h2 id="about-title">Water is connected.<br />Our understanding<br /><em>should be too.</em></h2><p>The National Integrated Water Information System brings South African water and climate information into one place, helping you explore the relationships between environmental conditions, water resources and services.</p><a href="#getting-started" className="nh-text-link">Find your way through the platform <ArrowRight size={18} aria-hidden="true" /></a></div>
          <div className="nh-capabilities">
            <article><span className="nh-capability-icon"><MapPinned size={24} strokeWidth={1.5} aria-hidden="true" /></span><div><h3>Place information in context</h3><p>Move from the national picture to district observations using the maps and geographic filters available in each module.</p></div><span className="nh-capability-number">01</span></article>
            <article><span className="nh-capability-icon"><ChartNoAxesCombined size={24} strokeWidth={1.5} aria-hidden="true" /></span><div><h3>Understand change over time</h3><p>Explore historical patterns, compare indicators and use the forecast tools available in supported dashboards.</p></div><span className="nh-capability-number">02</span></article>
            <article><span className="nh-capability-icon"><Database size={24} strokeWidth={1.5} aria-hidden="true" /></span><div><h3>Keep the evidence in view</h3><p>Read source information, measurement units and coverage alongside the data. Check gaps and limitations before drawing conclusions.</p></div><span className="nh-capability-number">03</span></article>
          </div>
        </div>
      </section>

      <section className="nh-getting-started nh-section" id="getting-started" aria-labelledby="getting-started-title">
        <div className="nh-container"><div className="nh-section-heading"><div><span className="nh-eyebrow">A SIMPLE PLACE TO START</span><h2 id="getting-started-title">From a question to a clearer picture.</h2></div><a className="nh-inline-link" href="#dashboards">Find a dashboard <ArrowUpRight size={18} aria-hidden="true" /></a></div>
          <div className="nh-steps"><article><span className="nh-step-number">01</span><h3>Choose your focus</h3><p>Start with a topic: drought, climate, water resources, quality or services.</p><a href="#dashboards">Browse the dashboards <ChevronRight size={16} aria-hidden="true" /></a></article><article><span className="nh-step-number">02</span><h3>Set the context</h3><p>Choose the available area, time period and indicator that fit your question.</p><span className="nh-step-note"><MapPinned size={14} aria-hidden="true" /> Geography and period filters</span></article><article><span className="nh-step-number">03</span><h3>Explore the evidence</h3><p>Read the maps and trends together with source notes, units and data coverage.</p><span className="nh-step-note"><Check size={14} aria-hidden="true" /> Context behind every insight</span></article></div>
        </div>
      </section>

      <section className="nh-closing" aria-labelledby="closing-title"><div className="nh-container nh-closing-inner"><div className="nh-closing-symbol" aria-hidden="true"><Droplets size={42} strokeWidth={1.2} /></div><div><span className="nh-eyebrow">EXPLORE. UNDERSTAND. INFORM.</span><h2 id="closing-title">A better understanding starts here.</h2><p>Explore South Africa’s water information, one connected view at a time.</p></div><a className="nh-button nh-button-dark" href="/drought">Enter the NIWIS portal <ArrowRight size={18} aria-hidden="true" /></a></div></section>
    </main>

    <footer className="nh-footer"><div className="nh-container"><div className="nh-footer-main"><div className="nh-footer-brand"><a href="/" aria-label="NIWIS home">NIWIS<span>.</span></a><p>National Integrated Water Information System<br />Department of Water and Sanitation</p></div><nav aria-label="Footer navigation"><a href="#dashboards">Dashboards</a><a href="#about">About NIWIS</a><a href="#getting-started">Getting started</a><a href="/drought">Enter portal <ArrowUpRight size={14} aria-hidden="true" /></a></nav><div className="nh-footer-purpose"><Droplets size={18} strokeWidth={1.5} aria-hidden="true" /><p>Reliable water information.<br /><strong>A more resilient South Africa.</strong></p></div></div><div className="nh-footer-bottom"><span>South Africa’s water. A shared responsibility.</span><span>Source coverage and update periods vary by dashboard.</span></div></div></footer>
  </div>
}
