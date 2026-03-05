import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

let map = null;
let markerCluster = null;
let connectionLines = [];

// Terminal green style for markers
const memberIcon = L.divIcon({
    className: 'map-marker',
    html: '<div class="map-marker-dot"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
});

// Cluster icon with member count
function createClusterIcon(cluster) {
    const count = cluster.getChildCount();
    return L.divIcon({
        html: `<div class="map-cluster">${count}</div>`,
        className: 'map-cluster-wrapper',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
    });
}

export function initMap(containerId) {
    if (map) return map;

    map = L.map(containerId, {
        center: [30, 0],
        zoom: 2,
        minZoom: 2,
        maxZoom: 12,
        zoomControl: false,
        attributionControl: false,
    });

    // Dark tiles with terminal green tint via CSS filter
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Add zoom control to bottom right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Marker cluster group
    markerCluster = L.markerClusterGroup({
        iconCreateFunction: createClusterIcon,
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
    });
    map.addLayer(markerCluster);

    return map;
}

export function updateMapMarkers(locations) {
    if (!markerCluster) return;
    markerCluster.clearLayers();

    // Clear old connection lines
    connectionLines.forEach(line => map.removeLayer(line));
    connectionLines = [];

    // Group locations by city for connection lines
    const cityGroups = {};

    locations.forEach(loc => {
        const marker = L.marker([loc.lat, loc.lng], { icon: memberIcon })
            .bindPopup(`
                <div class="map-popup">
                    <div class="map-popup-name">${loc.callsign || 'MEMBER'}</div>
                    <div class="map-popup-city">${loc.city}, ${loc.country}</div>
                </div>
            `);
        markerCluster.addLayer(marker);

        // Group by city for connection lines
        const key = `${loc.city}-${loc.country}`;
        if (!cityGroups[key]) {
            cityGroups[key] = { lat: loc.lat, lng: loc.lng, count: 0 };
        }
        cityGroups[key].count++;
    });

    // Draw connection lines between cities with 2+ members
    const cities = Object.values(cityGroups).filter(c => c.count >= 2);
    for (let i = 0; i < cities.length; i++) {
        for (let j = i + 1; j < cities.length; j++) {
            const line = L.polyline(
                [[cities[i].lat, cities[i].lng], [cities[j].lat, cities[j].lng]],
                {
                    color: '#00ff41',
                    weight: 1,
                    opacity: 0.2,
                    dashArray: '4 8',
                }
            ).addTo(map);
            connectionLines.push(line);
        }
    }
}

export function updateMapStats(stats) {
    const el = document.getElementById('map-stats');
    if (el && stats) {
        el.textContent = `[NETWORK] ${stats.members} OFFICERS | ${stats.cities} CITIES | ${stats.countries} COUNTRIES`;
    }
}

export function destroyMap() {
    if (map) {
        map.remove();
        map = null;
        markerCluster = null;
        connectionLines = [];
    }
}
