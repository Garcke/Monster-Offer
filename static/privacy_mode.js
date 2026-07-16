(() => {
    const api = window.monsterOfferPrivacy;
    if (!api || typeof api.getStatus !== 'function') return;

    const statusBadge = document.getElementById('privacyStatusBadge');
    const headerToggle = document.getElementById('privacyToggleButton');
    const shield = document.getElementById('privacyRedactionShield');
    const shieldToggle = document.getElementById('privacyShieldToggle');
    if (!statusBadge || !headerToggle || !shield || !shieldToggle) return;

    let currentStatus = {
        captureProtection: 'failed',
        redaction: 'off',
    };

    function captureLabel(state) {
        if (state === 'protected') return '窗口保护已开启';
        if (state === 'unsupported') return '系统不支持窗口保护';
        return '窗口保护需要检查';
    }

    function render(status) {
        currentStatus = {...currentStatus, ...status};
        const captureState = currentStatus.captureProtection;
        const redacted = currentStatus.redaction === 'on';
        statusBadge.className = `privacy-status privacy-${captureState}`;
        statusBadge.textContent = captureLabel(captureState);
        statusBadge.title = captureState === 'protected'
            ? '支持的屏幕捕获路径将尝试排除 Meeting-Monster 窗口'
            : '请开启内容脱敏模式，并优先共享指定窗口';
        headerToggle.classList.remove('hidden');
        headerToggle.textContent = redacted ? '退出脱敏' : '开启脱敏';
        headerToggle.setAttribute('aria-pressed', String(redacted));
        shieldToggle.textContent = redacted ? '恢复显示' : '开启脱敏';
        shield.classList.toggle('hidden', !redacted);
        document.body.classList.toggle('privacy-redacted', redacted);
    }

    async function toggleRedaction() {
        headerToggle.disabled = true;
        shieldToggle.disabled = true;
        try {
            render(await api.setRedacted(currentStatus.redaction !== 'on'));
        } catch {
            statusBadge.className = 'privacy-status privacy-failed';
            statusBadge.textContent = '隐私状态不可用';
        } finally {
            headerToggle.disabled = false;
            shieldToggle.disabled = false;
        }
    }

    headerToggle.addEventListener('click', toggleRedaction);
    shieldToggle.addEventListener('click', toggleRedaction);
    const removeStatusListener = api.onStatus(render);
    api.getStatus().then(render).catch(() => {
        render({captureProtection: 'failed'});
    });

    window.addEventListener('pagehide', () => {
        if (typeof removeStatusListener === 'function') removeStatusListener();
    }, {once: true});
})();
