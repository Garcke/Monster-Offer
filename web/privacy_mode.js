(() => {
    const api = window.monsterOfferPrivacy;
    if (!api || typeof api.getStatus !== 'function' || typeof api.setCaptureProtection !== 'function') return;

    const statusBadge = document.getElementById('privacyStatusBadge');
    const capsuleToggle = document.getElementById('capsuleProtectionToggle');
    if (!statusBadge || !capsuleToggle) return;

    let currentStatus = {
        captureProtection: 'failed',
        captureProtectionEnabled: true,
    };

    function captureLabel(state) {
        if (state === 'protected') return '窗口保护已开启';
        if (state === 'disabled') return '窗口保护已关闭';
        if (state === 'unsupported') return '系统不支持窗口保护';
        return '窗口保护需要检查';
    }

    function render(status) {
        currentStatus = {...currentStatus, ...status};
        const captureState = currentStatus.captureProtection;
        const enabled = currentStatus.captureProtectionEnabled === true && captureState === 'protected';

        statusBadge.className = `privacy-status privacy-${captureState}`;
        statusBadge.textContent = captureLabel(captureState);
        statusBadge.title = enabled
            ? '系统会尝试排除该窗口的录屏和屏幕共享捕获'
            : '窗口内容保护当前未开启';

        capsuleToggle.className = `capsule-button capsule-button-protection privacy-${captureState}`;
        capsuleToggle.textContent = enabled ? '保护中' : captureState === 'disabled' ? '未保护' : '不可用';
        capsuleToggle.setAttribute('aria-pressed', String(enabled));
        capsuleToggle.setAttribute('aria-label', enabled ? '关闭窗口保护' : '开启窗口保护');
        capsuleToggle.disabled = captureState === 'unsupported';
    }

    async function toggleCaptureProtection() {
        capsuleToggle.disabled = true;
        try {
            render(await api.setCaptureProtection(currentStatus.captureProtectionEnabled !== true));
        } catch {
            render({captureProtection: 'failed', captureProtectionEnabled: false});
        }
    }

    capsuleToggle.addEventListener('click', toggleCaptureProtection);
    const removeStatusListener = api.onStatus(render);
    api.getStatus().then(render).catch(() => {
        render({captureProtection: 'failed', captureProtectionEnabled: false});
    });

    window.addEventListener('pagehide', () => {
        if (typeof removeStatusListener === 'function') removeStatusListener();
    }, {once: true});
})();
