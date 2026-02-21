import { useState, useEffect } from 'react'
import './App.css'

function App() {
    const [isEnabled, setIsEnabled] = useState(false)
    const [sites, setSites] = useState([])
    const [newSite, setNewSite] = useState('')
    const [proxyConfig, setProxyConfig] = useState('')
    const [country, setCountry] = useState('')
    const [geoReady, setGeoReady] = useState(false)
    const [proxyFocused, setProxyFocused] = useState(false)
    const [proxyStatus, setProxyStatus] = useState(null) // null=checking, true=ok, false=fail

    useEffect(() => {
        chrome.storage.local.get(['isEnabled', 'proxyConfig', 'geoReady'], (result) => {
            setIsEnabled(result.isEnabled || false)
            setProxyConfig(result.proxyConfig || '')
            setGeoReady(result.geoReady || false)
        })
        chrome.storage.sync.get(['sites'], (result) => {
            setSites(result.sites || [])
        })

        chrome.storage.onChanged.addListener((changes) => {
            if (changes.geoReady) setGeoReady(changes.geoReady.newValue || false)
        })
    }, [])

    useEffect(() => {
        const ip = proxyConfig.split(':')[0]
        if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
            fetch(`https://ip-api.com/json/${ip}?fields=country&lang=ru`)
                .then(res => res.json())
                .then(data => {
                    if (data.country) setCountry(data.country)
                    else setCountry('')
                })
                .catch(() => setCountry(''))
        } else {
            setCountry('')
        }
    }, [proxyConfig])

    // Проверка доступности youtube.com (таймаут 3 сек)
    const checkProxy = () => {
        setProxyStatus(null)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        fetch('https://www.youtube.com/favicon.ico', { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
            .then(() => setProxyStatus(true))
            .catch(() => setProxyStatus(false))
            .finally(() => clearTimeout(timeout))
    }

    const toggleProxy = () => {
        const newState = !isEnabled
        setIsEnabled(newState)
        chrome.storage.local.set({ isEnabled: newState })
        setTimeout(checkProxy, 500)
    }

    const handleProxyChange = (e) => {
        const newValue = e.target.value
        setProxyConfig(newValue)
        chrome.storage.local.set({ proxyConfig: newValue })
    }

    const addSite = (e) => {
        e.preventDefault()
        // Нормализация: убираем протокол, путь, слэши — оставляем только домен
        let domain = newSite.trim().toLowerCase()
        try {
            domain = new URL(domain.includes('://') ? domain : 'https://' + domain).hostname
        } catch { }
        if (domain && !sites.includes(domain)) {
            const updatedSites = [...sites, domain]
            setSites(updatedSites)
            chrome.storage.sync.set({ sites: updatedSites })
            setNewSite('')
        }
    }

    const removeSite = (siteToRemove) => {
        const updatedSites = sites.filter(site => site !== siteToRemove)
        setSites(updatedSites)
        chrome.storage.sync.set({ sites: updatedSites })
    }

    return (
        <div className="container">
            <header>
                <h1>Auto Proxy</h1>
                <div className="toggle-wrapper">
                    <span className={`status ${isEnabled ? 'active' : ''}`}>
                        {isEnabled ? 'ВКЛ' : 'ВЫКЛ'}
                    </span>
                    <label className="switch">
                        <input type="checkbox" checked={isEnabled} onChange={toggleProxy} />
                        <span className="slider round"></span>
                    </label>
                </div>
            </header>

            <main>
                <section className="config-section">
                    <h2>
                        Настройки прокси
                        <span style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            marginLeft: 6,
                            background: proxyStatus === null ? '#94a3b8' : proxyStatus ? '#22c55e' : '#ef4444',
                            verticalAlign: 'middle'
                        }} />
                    </h2>
                    <input
                        type={proxyFocused ? 'text' : 'password'}
                        className="proxy-input"
                        placeholder="IP:port:login:pass"
                        value={proxyConfig}
                        onChange={handleProxyChange}
                        onFocus={() => setProxyFocused(true)}
                        onBlur={() => setProxyFocused(false)}
                    />
                </section>

                <section className="site-list">
                    <h2>Дополнительные сайты</h2>
                    <div className="scroll-area">
                        {sites.map(site => (
                            <div key={site} className="site-item">
                                <span>{site}</span>
                                <button onClick={() => removeSite(site)} className="btn-remove">×</button>
                            </div>
                        ))}
                    </div>
                </section>

                <form onSubmit={addSite} className="add-site">
                    <input
                        type="text"
                        placeholder="example.com"
                        value={newSite}
                        onChange={(e) => setNewSite(e.target.value)}
                    />
                    <button type="submit" className="btn-add">Добавить</button>
                </form>
            </main>

            <footer>
                <p>Прокси: {proxyConfig.split(':')[0] || '---'} {country && `(${country})`}</p>
            </footer>
        </div>
    )
}

export default App
