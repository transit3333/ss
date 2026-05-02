// ======= MAIN APPLICATION INITIALIZATION =======
// Dependencies: All other modules

function initTheme() {
    const saved = localStorage.getItem('metro_theme');
    const theme = saved || 'dark'; // default dark
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);

    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('metro_theme', next);
            updateThemeIcon(next);
        });
    }
}

function updateThemeIcon(theme) {
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
        toggle.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    }
}

function initApp() {
    initTheme();
    initToolbar();
    initViewport();
    if (typeof initLivePlanner === 'function') initLivePlanner();
    const rect = viewport.getBoundingClientRect();
    cameraX = rect.width / 2;
    cameraY = rect.height / 2;
    updateTransform();
    loadMapFromUrl('chicago.json').catch(e => console.log('No default map', e));
}

// Initialize everything
initApp();
initRouteFinder();
