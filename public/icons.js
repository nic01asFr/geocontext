/**
 * Icônes SVG maison (trait 1.75, 24×24, currentColor). Aucune dépendance, aucun emoji.
 * Icon("nom", taille?) → chaîne SVG ; les éléments [data-icon] sont remplis au chargement.
 */
(function () {
  const P = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>',
    building: '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/><path d="M9 12h.01M15 12h.01"/>',
    "map-pin": '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.5h17M3.5 15h17M9.5 3.5v17M15 3.5v17"/>',
    "alert-triangle": '<path d="M12 3.8 21 19.5H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.8" r=".6" fill="currentColor"/>',
    leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14"/><path d="M5 19c2-4 5-7 9-9"/>',
    truck: '<path d="M4 18 9 4M20 18 15 4"/><path d="M12 6v2.5M12 11.5V14M12 17v2"/>',
    droplets: '<path d="M12 3.5s-6 6.3-6 10.5a6 6 0 0 0 12 0C18 9.8 12 3.5 12 3.5z"/><path d="M9.2 14.5a3 3 0 0 0 2.3 2.7"/>',
    briefcase: '<rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5"/><path d="M3 13h18"/>',
    home: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
    zap: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    layers: '<path d="m12 3.5 9 4.5-9 4.5L3 8z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    "bar-chart": '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7.5 10 3 2.5-3 2.5M13 15h4"/>',
    contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
    send: '<path d="M4 12 20 4l-4 16-4.5-6.5z"/><path d="m11.5 13.5 8-9.5"/>',
    "chevron-down": '<path d="m6 9.5 6 6 6-6"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "arrow-up": '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
    "arrow-down": '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>',
    back: '<path d="M9.5 6 4 11.5 9.5 17"/><path d="M4 11.5h10a6 6 0 0 1 6 6V19"/>',
    filter: '<path d="M4 5h16l-6.2 7.5V19l-3.6-1.8v-4.7z"/>',
    clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
    play: '<path d="M8 5.500v13l11-6.500z" fill="currentColor"/>',
    pause: '<path d="M8.500 5.500v13M15.500 5.500v13"/>',
    pin: '<path d="M9 3.500h6M10 3.500l-.7 6.200L6.500 13h11l-2.800-3.300L14 3.500"/><path d="M12 13v7.500"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4"/><path d="M5.5 3v4h4M18.5 21v-4h-4"/>',
  };
  const ALIAS = { identite: "info", urbanisme: "building", cadastre: "grid", risques: "alert-triangle", environnement: "leaf", transport: "truck", hydrologie: "droplets", bati: "home", economie: "briefcase" };
  function Icon(nom, taille) {
    const d = P[nom] || P[ALIAS[nom]] || P.layers;
    const t = taille || 18;
    return `<svg class="ico" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
  }
  function remplir(racine) {
    (racine || document).querySelectorAll("[data-icon]").forEach((el) => {
      if (el.dataset.iconOk) return;
      el.insertAdjacentHTML("afterbegin", Icon(el.dataset.icon, +el.dataset.iconSize || 18));
      el.dataset.iconOk = "1";
    });
  }
  window.Icon = Icon; window.remplirIcones = remplir;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => remplir()); else remplir();
})();
