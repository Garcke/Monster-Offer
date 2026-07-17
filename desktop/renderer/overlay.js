import PCMAudioRecorder from './audio_recorder.js';
import {createQuestionStore, parseAsrMessage} from './question_store.js';

const serverUrl = window.meetingMonsterDesktop?.serverUrl || window.location.origin;
const API_BASE_URL = `${serverUrl}/api`;
const asrUrl = new URL('/ws/asr', serverUrl);
asrUrl.protocol = asrUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const ASR_WEBSOCKET_URL = asrUrl.href;

const overlayRoot = document.getElementById('overlayRoot');
const statusText = document.getElementById('overlayStatusText');
const liveDot = document.getElementById('overlayLiveDot');
const protectionButton = document.getElementById('capsuleProtectionToggle');
const expandButton = document.getElementById('floatingExpandButton');
const hideButton = document.getElementById('floatingHideButton');
const transcript = document.getElementById('overlayTranscript');
const promptLabel = document.getElementById('overlayPromptLabel');
const questionCount = document.getElementById('overlayQuestionCount');
const answer = document.getElementById('overlayAnswer');
const answerStatus = document.getElementById('overlayAnswerStatus');
const composer = document.getElementById('overlayComposer');
const input = document.getElementById('overlayInput');
const startButton = document.getElementById('overlayStartButton');
const stopButton = document.getElementById('overlayStopButton');
const clearButton = document.getElementById('overlayClearButton');
const answerButton = document.getElementById('overlayAnswerButton');
const copyButton = document.getElementById('overlayCopyButton');
const assistButton = document.getElementById('overlayAssistButton');
const followupButton = document.getElementById('overlayFollowupButton');
const recapButton = document.getElementById('overlayRecapButton');

const desktopApi = window.meetingMonsterDesktop;
const privacyApi = window.monsterOfferPrivacy;
const questionStore = createQuestionStore();
const recorder = new PCMAudioRecorder();

let activePartialTranscript = '';
let ws = null;
let isRecordingStopping = false;
let isSending = false;
let activeAction = 'assist';
let isExpanded = false;

function setStatus(message, state = 'ready') {
    statusText.textContent = message;
    liveDot.classList.toggle('is-recording', state === 'recording');
}

function renderWindowState(state = {}) {
    isExpanded = state.mode === 'expanded';
    overlayRoot.classList.toggle('is-expanded', isExpanded);
    overlayRoot.classList.toggle('is-capsule', !isExpanded);
    expandButton.innerHTML = isExpanded ? '收起 <span aria-hidden="true">⌃</span>' : '展开 <span aria-hidden="true">⌄</span>';
    expandButton.setAttribute('aria-label', isExpanded ? '收起工作台' : '展开工作台');
    expandButton.setAttribute('aria-expanded', String(isExpanded));
}

function renderProtectionStatus(status = {}) {
    const captureState = status.captureProtection || 'failed';
    const enabled = status.captureProtectionEnabled === true && captureState === 'protected';
    protectionButton.className = `overlay-button protection-button privacy-${captureState}`;
    protectionButton.textContent = enabled ? '保护中' : captureState === 'disabled' ? '未保护' : '不可用';
    protectionButton.setAttribute('aria-pressed', String(enabled));
    protectionButton.setAttribute('aria-label', enabled ? '关闭窗口保护' : '开启窗口保护');
    protectionButton.disabled = captureState === 'unsupported';
}

function createTextElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function renderTranscript() {
    const questions = questionStore.getQuestions();
    const selected = questionStore.getSelected();
    transcript.innerHTML = '';
    questionCount.textContent = `${questions.length} 条`;

    if (!questions.length && !activePartialTranscript) {
        transcript.appendChild(createTextElement('div', 'overlay-empty-state', '开始转写后，当前问题会显示在这里'));
    }

    questions.slice(-4).forEach((item) => {
        const paragraph = createTextElement('p', item.id === selected?.id ? 'is-selected' : '', item.text);
        paragraph.dataset.questionId = item.id;
        paragraph.tabIndex = 0;
        paragraph.setAttribute('role', 'button');
        paragraph.addEventListener('click', () => {
            questionStore.selectQuestion(item.id);
            renderTranscript();
            renderAnswer();
        });
        transcript.appendChild(paragraph);
    });

    if (activePartialTranscript) {
        transcript.appendChild(createTextElement('p', 'is-partial', activePartialTranscript));
    }
}

function setAnswerState(label, state = 'idle') {
    answerStatus.textContent = label;
    answerStatus.className = `answer-status ${state === 'loading' ? 'is-loading' : state === 'complete' ? 'is-complete' : state === 'error' ? 'is-error' : ''}`;
}

function renderMarkdown(target, text) {
    if (!text) return;
    if (globalThis.marked?.parse) {
        target.innerHTML = globalThis.marked.parse(text);
    } else {
        target.textContent = text;
    }
}

function renderAnswer() {
    const selected = questionStore.getSelected();
    answer.innerHTML = '';
    const hasQuestion = Boolean(selected);
    [assistButton, followupButton, recapButton].forEach((button) => {
        button.disabled = !hasQuestion || isSending;
    });
    copyButton.disabled = !selected?.answer;
    answerButton.disabled = !hasQuestion || isSending;

    if (!selected) {
        setAnswerState('等待问题');
        answer.appendChild(createTextElement('div', 'overlay-answer-empty', '选择一个问题后，点击 Assist 生成回答'));
        return;
    }

    if (selected.answerStatus === 'loading') {
        setAnswerState('生成中', 'loading');
        answer.appendChild(createTextElement('div', 'overlay-answer-empty', '正在组织回答…'));
    } else if (selected.answerStatus === 'error') {
        setAnswerState('生成失败', 'error');
        answer.appendChild(createTextElement('div', 'overlay-answer-empty', selected.errorMessage || 'AI 服务连接失败'));
    } else if (selected.answer) {
        setAnswerState('已完成', 'complete');
        renderMarkdown(answer, selected.answer);
    } else {
        setAnswerState('等待生成');
        answer.appendChild(createTextElement('div', 'overlay-answer-empty', '当前问题已选中，点击 Assist 生成回答'));
    }
}

function buildPrompt(question, action) {
    if (action === 'followup') return `请基于这个面试问题，给出一个有深度且自然的追问：\n${question}`;
    if (action === 'recap') return `请简洁重述这个面试问题，并提炼出回答重点：\n${question}`;
    return question;
}

async function sendQuestionToAI(questionId, action = activeAction) {
    if (isSending) return;
    const question = questionStore.getQuestion(questionId);
    if (!question) return;

    isSending = true;
    questionStore.selectQuestion(question.id);
    questionStore.resetAnswer(question.id);
    questionStore.setAnswerStatus(question.id, 'loading');
    renderTranscript();
    renderAnswer();

    try {
        const response = await fetch(`${API_BASE_URL}/chat/`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: buildPrompt(question.text, action)}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error('AI 服务未返回可读取的数据流');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const rawEvent of events) {
                let eventName = 'message';
                let data = '';
                rawEvent.split('\n').forEach((line) => {
                    if (line.startsWith('event:')) eventName = line.slice(6).trim();
                    if (line.startsWith('data:')) data += line.slice(5).trim();
                });
                if (!data) continue;
                const payload = JSON.parse(data);
                if (eventName === 'error') throw new Error(payload.detail || '模型生成失败');
                if (typeof payload.response === 'string') {
                    questionStore.appendAnswer(question.id, payload.response);
                    renderAnswer();
                }
            }
        }
        if (!questionStore.getQuestion(question.id)?.answer) throw new Error('模型没有返回回答内容');
        questionStore.setAnswerStatus(question.id, 'complete');
    } catch (error) {
        console.error('AI request failed:', error);
        questionStore.setAnswerStatus(question.id, 'error', `AI 服务连接失败：${error.message || '请检查本地服务'}`);
    } finally {
        isSending = false;
        renderTranscript();
        renderAnswer();
    }
}

function addQuestion(text, source = 'manual') {
    const question = questionStore.addQuestion(text, source);
    if (!question) return null;
    renderTranscript();
    renderAnswer();
    return question;
}

function parseAsrResponse(message) {
    const payload = parseAsrMessage(message);
    if (payload.kind === 'invalid') return;
    if (payload.kind === 'error') {
        setStatus(`识别失败：${payload.message}`, 'error');
        return;
    }
    if (payload.kind === 'final') {
        activePartialTranscript = '';
        addQuestion(payload.text, 'asr');
    } else {
        activePartialTranscript = payload.text;
        renderTranscript();
    }
}

function waitForWebSocketOpen(socket, timeoutMs = 5000) {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            cleanup();
            reject(new Error('连接本地语音服务超时'));
        }, timeoutMs);
        const cleanup = () => {
            window.clearTimeout(timer);
            socket.removeEventListener('open', handleOpen);
            socket.removeEventListener('error', handleError);
            socket.removeEventListener('close', handleClose);
        };
        const handleOpen = () => { cleanup(); resolve(); };
        const handleError = () => { cleanup(); reject(new Error('无法连接本地语音服务')); };
        const handleClose = () => { cleanup(); reject(new Error('本地语音服务已断开')); };
        socket.addEventListener('open', handleOpen, {once: true});
        socket.addEventListener('error', handleError, {once: true});
        socket.addEventListener('close', handleClose, {once: true});
    });
}

function resetRecordingControls() {
    startButton.disabled = false;
    stopButton.disabled = true;
    isRecordingStopping = false;
}

async function startRecording() {
    startButton.disabled = true;
    stopButton.disabled = true;
    activePartialTranscript = '';
    renderTranscript();
    setStatus('正在连接本地识别…', 'processing');

    try {
        const socket = new WebSocket(ASR_WEBSOCKET_URL);
        ws = socket;
        socket.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            if (event.data === 'asr stopped') socket.close(1000, 'ASR stopped');
            else parseAsrResponse(event.data);
        };
        socket.onclose = async () => {
            if (!isRecordingStopping) await recorder.stop().catch(console.error);
            if (ws === socket) ws = null;
            resetRecordingControls();
            if (!statusText.textContent.includes('失败')) setStatus('转写已完成', 'success');
        };
        socket.onerror = () => setStatus('本地语音服务连接异常', 'error');
        await waitForWebSocketOpen(socket);
        let audioConfigSent = false;
        await recorder.connect((pcmData, actualSampleRate) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            if (!audioConfigSent) {
                socket.send(JSON.stringify({type: 'audio_config', sample_rate: actualSampleRate}));
                audioConfigSent = true;
            }
            socket.send(pcmData);
        });
        stopButton.disabled = false;
        setStatus('正在实时转写', 'recording');
    } catch (error) {
        console.error('启动录音失败:', error);
        setStatus(`启动失败：${error.message || error}`, 'error');
        await recorder.stop().catch(console.error);
        ws?.close();
        ws = null;
        resetRecordingControls();
    }
}

async function stopRecording() {
    if (isRecordingStopping) return;
    isRecordingStopping = true;
    stopButton.disabled = true;
    setStatus('正在整理最终文本…', 'processing');
    const socket = ws;
    try {
        await recorder.stop();
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send('stop');
            window.setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'ASR stop timeout');
            }, 5000);
        } else {
            socket?.close();
            resetRecordingControls();
        }
    } catch (error) {
        console.error('停止录音失败:', error);
        socket?.close();
        resetRecordingControls();
    }
}

function submitInput(event) {
    event?.preventDefault();
    if (isSending) return;
    const text = input.value.trim();
    if (!text) {
        const selected = questionStore.getSelected();
        if (selected) sendQuestionToAI(selected.id, activeAction);
        return;
    }
    const question = addQuestion(text, 'manual');
    input.value = '';
    if (question) sendQuestionToAI(question.id, activeAction);
}

function copySelectedAnswer() {
    const selected = questionStore.getSelected();
    if (!selected?.answer) return;
    navigator.clipboard.writeText(selected.answer)
        .then(() => setStatus('回答已复制', 'success'))
        .catch(() => setStatus('复制失败，请手动选择文本', 'error'));
}

function setAction(action, label) {
    activeAction = action;
    promptLabel.textContent = label;
    [assistButton, followupButton, recapButton].forEach((button) => button.classList.remove('is-active'));
    const target = action === 'assist' ? assistButton : action === 'followup' ? followupButton : recapButton;
    target.classList.add('is-active');
    const selected = questionStore.getSelected();
    if (selected && action !== 'assist') sendQuestionToAI(selected.id, action);
}

expandButton.addEventListener('click', () => {
    desktopApi?.setExpanded(!isExpanded).then(renderWindowState).catch(() => {});
});
hideButton.addEventListener('click', () => desktopApi?.hideWindow().catch(() => {}));
protectionButton.addEventListener('click', async () => {
    if (!privacyApi?.getStatus || !privacyApi?.setCaptureProtection) return;
    protectionButton.disabled = true;
    try {
        const current = await privacyApi.getStatus();
        renderProtectionStatus(await privacyApi.setCaptureProtection(current.captureProtectionEnabled !== true));
    } catch {
        renderProtectionStatus({captureProtection: 'failed', captureProtectionEnabled: false});
    }
});
startButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);
clearButton.addEventListener('click', () => {
    questionStore.clear();
    activePartialTranscript = '';
    input.value = '';
    setAction('assist', 'What should I say?');
    renderTranscript();
    renderAnswer();
    setStatus('内容已清空', 'success');
});
copyButton.addEventListener('click', copySelectedAnswer);
assistButton.addEventListener('click', () => setAction('assist', 'What should I say?'));
followupButton.addEventListener('click', () => setAction('followup', 'Follow-up question'));
recapButton.addEventListener('click', () => setAction('recap', 'Recap this answer'));
composer.addEventListener('submit', submitInput);
input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitInput(event);
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isExpanded) {
        desktopApi?.setExpanded(false).then(renderWindowState).catch(() => {});
    }
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (event.code === 'KeyA') {
        event.preventDefault();
        if (!startButton.disabled) startButton.click();
        else if (!stopButton.disabled) stopButton.click();
    }
});

desktopApi?.onWindowState(renderWindowState);
desktopApi?.getWindowState().then(renderWindowState).catch(() => renderWindowState({mode: 'capsule'}));
privacyApi?.onStatus(renderProtectionStatus);
privacyApi?.getStatus().then(renderProtectionStatus).catch(() => renderProtectionStatus({captureProtection: 'failed'}));

renderTranscript();
renderAnswer();
