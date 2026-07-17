(() => {
    const api = window.meetingMonsterDesktop;
    if (!api || typeof api.getWindowState !== 'function') {
        document.body.classList.remove('floating-capsule');
        document.body.classList.add('floating-expanded');
        return;
    }

    const expandButton = document.getElementById('floatingExpandButton');
    const hideButton = document.getElementById('floatingHideButton');
    if (!expandButton || !hideButton) return;

    let currentMode = 'capsule';

    function render(state = {}) {
        currentMode = state.mode === 'expanded' ? 'expanded' : 'capsule';
        document.body.classList.toggle('floating-capsule', currentMode === 'capsule');
        document.body.classList.toggle('floating-expanded', currentMode === 'expanded');
        const expanded = currentMode === 'expanded';
        expandButton.innerHTML = expanded ? '收起 <span aria-hidden="true">⌃</span>' : '展开 <span aria-hidden="true">⌄</span>';
        expandButton.setAttribute('aria-label', expanded ? '收起工作台' : '展开工作台');
        expandButton.setAttribute('aria-expanded', String(expanded));
    }

    async function setExpanded(expanded) {
        expandButton.disabled = true;
        try {
            render(await api.setExpanded(expanded));
        } catch {
            render({mode: currentMode});
        } finally {
            expandButton.disabled = false;
        }
    }

    expandButton.addEventListener('click', () => setExpanded(currentMode !== 'expanded'));
    hideButton.addEventListener('click', () => api.hideWindow().catch(() => {}));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && currentMode === 'expanded') {
            event.preventDefault();
            setExpanded(false);
        }
    });

    api.onWindowState(render);
    api.getWindowState().then(render).catch(() => render({mode: 'capsule'}));
})();
