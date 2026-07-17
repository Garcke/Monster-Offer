import PCMAudioRecorder from './audio_recorder.js';
import {createQuestionStore, parseAsrMessage} from './question_store.js';

const API_BASE_URL = `${window.location.origin}/api`;
const ASR_WEBSOCKET_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ASR_WEBSOCKET_URL = `${ASR_WEBSOCKET_PROTOCOL}//${window.location.host}/ws/asr`;

const appShell = document.querySelector('.app-shell');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const clearButton = document.getElementById('clearButton');
const outputButton = document.getElementById('outputButton');
const manualInput = document.getElementById('manualInput');
const manualSendButton = document.getElementById('manualSendButton');
const transcriptList = document.getElementById('transcriptList');
const questionCount = document.getElementById('questionCount');
const outputDiv = document.getElementById('outputText');
const selectedQuestionText = document.getElementById('selectedQuestionText');
const answerStatusBadge = document.getElementById('answerStatusBadge');
const copyAnswerButton = document.getElementById('copyAnswerButton');
const recordingStatus = document.getElementById('recordingStatus');
const recordingStatusText = document.getElementById('recordingStatusText');
const mobileTabs = document.querySelectorAll('.mobile-tab');
const saveTXTButton = document.getElementById('saveTXTButton');
const modelStatus = document.getElementById('modelStatus');

const questionStore = createQuestionStore();
const recorder = new PCMAudioRecorder();
let activePartialTranscript = '';
let ws = null;
let isSending = false;
let isRecordingStopping = false;
let isUserScrolling = false;

function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function switchPanel(panel) {
    if (!['interview', 'answer'].includes(panel)) return;
    appShell.dataset.activePanel = panel;
    mobileTabs.forEach((tab) => {
        const isActive = tab.dataset.panel === panel;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });
}

mobileTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchPanel(tab.dataset.panel));
});

function createTranscriptEmptyState() {
    const state = createElement('div', 'empty-state compact-empty');
    const icon = createElement('span', 'empty-state-icon', '◌');
    icon.setAttribute('aria-hidden', 'true');
    state.append(icon, createElement('h3', '', '等待面试内容'));
    state.appendChild(createElement('p', '', '点击下方“开始转写”，识别结果会按句出现在这里。'));
    return state;
}

function copyText(text, successMessage) {
    if (!text) return;
    navigator.clipboard.writeText(text)
        .then(() => setRecordingStatus(successMessage, 'success'))
        .catch(() => setRecordingStatus('复制失败，请手动选择文本', 'error'));
}

function renderQuestionList(scrollToEnd = false) {
    const questions = questionStore.getQuestions();
    transcriptList.innerHTML = '';
    questionCount.textContent = String(questions.length);

    if (!questions.length && !activePartialTranscript) {
        transcriptList.appendChild(createTranscriptEmptyState());
        return;
    }

    const selected = questionStore.getSelected();
    questions.forEach((question, index) => {
        const item = createElement('article', 'question-item');
        item.dataset.questionId = question.id;
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `选择问题：${question.text}`);
        item.classList.toggle('is-selected', selected?.id === question.id);

        item.appendChild(createElement('p', 'question-text', question.text));
        const meta = createElement('div', 'question-meta');
        const sourceLabel = question.source === 'manual' ? '手动输入' : `语音转写 ${index + 1}`;
        meta.appendChild(createElement('span', 'question-source', sourceLabel));

        const actions = createElement('div', 'question-actions');
        const copyButton = createElement('button', 'text-action', '复制');
        copyButton.type = 'button';
        copyButton.addEventListener('click', (event) => {
            event.stopPropagation();
            copyText(question.text, '问题已复制');
        });
        const answerButton = createElement(
            'button',
            'text-action',
            question.answerStatus === 'complete' ? '查看回答' : '生成回答'
        );
        answerButton.type = 'button';
        answerButton.disabled = isSending && question.answerStatus !== 'loading';
        answerButton.addEventListener('click', (event) => {
            event.stopPropagation();
            questionStore.selectQuestion(question.id);
            renderQuestionList();
            renderSelectedAnswer();
            switchPanel('answer');
            if (question.answerStatus !== 'complete') sendQuestionToAI(question.id);
        });
        actions.append(copyButton, answerButton);
        meta.appendChild(actions);
        item.appendChild(meta);

        const selectItem = () => {
            questionStore.selectQuestion(question.id);
            renderQuestionList();
            renderSelectedAnswer();
        };
        item.addEventListener('click', selectItem);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectItem();
            }
        });
        transcriptList.appendChild(item);
    });

    if (activePartialTranscript) {
        const partialItem = createElement('article', 'question-item is-partial');
        partialItem.appendChild(createElement('p', 'question-text', activePartialTranscript));
        transcriptList.appendChild(partialItem);
    }

    if (scrollToEnd) transcriptList.scrollTop = transcriptList.scrollHeight;
}

function setAnswerBadge(status) {
    const labels = {
        idle: '等待生成',
        loading: '生成中',
        complete: '已完成',
        error: '生成失败',
        empty: '等待问题',
    };
    answerStatusBadge.textContent = labels[status] || labels.empty;
    answerStatusBadge.className = `answer-status status-${status === 'empty' ? 'idle' : status}`;
}

function createAnswerEmptyState(title, description) {
    const state = createElement('div', 'empty-state');
    const icon = createElement('span', 'empty-state-icon', '✦');
    icon.setAttribute('aria-hidden', 'true');
    state.append(icon, createElement('h3', '', title), createElement('p', '', description));
    return state;
}

function renderMarkdown(element, text) {
    if (!text) return;
    if (!globalThis.marked?.parse) {
        element.textContent = text;
        return;
    }
    element.innerHTML = globalThis.marked.parse(text);
    if (globalThis.hljs?.highlightElement) {
        element.querySelectorAll('pre code').forEach((block) => globalThis.hljs.highlightElement(block));
    }
}

function renderSelectedAnswer() {
    const question = questionStore.getSelected();
    outputDiv.innerHTML = '';

    if (!question) {
        selectedQuestionText.textContent = '请先从左侧选择一个问题';
        outputButton.textContent = '生成回答';
        outputButton.disabled = true;
        copyAnswerButton.disabled = true;
        setAnswerBadge('empty');
        outputDiv.appendChild(createAnswerEmptyState('选择一个面试问题', '左侧转写完成后，选中问题并点击“生成回答”。'));
        return;
    }

    selectedQuestionText.textContent = question.text;
    outputButton.textContent = question.answerStatus === 'complete' ? '重新生成' : '生成回答';
    outputButton.disabled = isSending;
    copyAnswerButton.disabled = !question.answer;
    setAnswerBadge(question.answerStatus);

    if (question.answer) {
        const answer = createElement('article', 'answer-content');
        renderMarkdown(answer, question.answer);
        outputDiv.appendChild(answer);
    } else if (question.answerStatus === 'loading') {
        const loading = createElement('div', 'answer-loading');
        const dots = createElement('span', 'loading-dots');
        dots.append(createElement('span'), createElement('span'), createElement('span'));
        loading.append(dots, document.createTextNode('正在组织回答…'));
        outputDiv.appendChild(loading);
    } else if (question.answerStatus === 'error') {
        outputDiv.appendChild(createElement('div', 'error-card', question.errorMessage || 'AI 服务连接失败，请稍后重试。'));
    } else {
        outputDiv.appendChild(createAnswerEmptyState('问题已选中', '点击右上角“生成回答”，AI 将为当前问题提供建议。'));
    }

    if (!isUserScrolling) outputDiv.scrollTop = outputDiv.scrollHeight;
}

async function sendQuestionToAI(questionId) {
    if (isSending) return;
    const question = questionStore.getQuestion(questionId);
    if (!question) return;

    isSending = true;
    questionStore.selectQuestion(question.id);
    questionStore.resetAnswer(question.id);
    questionStore.setAnswerStatus(question.id, 'loading');
    renderQuestionList();
    renderSelectedAnswer();

    try {
        const response = await fetch(`${API_BASE_URL}/chat/`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: question.text}),
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
                if (eventName === 'error') {
                    throw new Error(payload.detail || '模型生成失败');
                }
                if (typeof payload.response === 'string') {
                    questionStore.appendAnswer(question.id, payload.response);
                    if (questionStore.getSelected()?.id === question.id) renderSelectedAnswer();
                }
            }
        }

        if (!questionStore.getQuestion(question.id).answer) throw new Error('模型没有返回回答内容');
        questionStore.setAnswerStatus(question.id, 'complete');
    } catch (error) {
        console.error('AI request failed:', error);
        questionStore.setAnswerStatus(
            question.id,
            'error',
            `AI 服务连接失败：${error.message || '请检查本地服务与模型配置'}`
        );
    } finally {
        isSending = false;
        renderQuestionList();
        if (questionStore.getSelected()?.id === question.id) renderSelectedAnswer();
    }
}

function submitManualQuestion() {
    if (isSending) return;
    const question = questionStore.addQuestion(manualInput.value, 'manual');
    if (!question) {
        manualInput.focus();
        return;
    }
    manualInput.value = '';
    renderQuestionList(true);
    renderSelectedAnswer();
    switchPanel('answer');
    sendQuestionToAI(question.id);
}

manualSendButton.addEventListener('click', submitManualQuestion);
manualInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        submitManualQuestion();
    }
});

outputButton.addEventListener('click', () => {
    const selected = questionStore.getSelected();
    if (selected) sendQuestionToAI(selected.id);
});

copyAnswerButton.addEventListener('click', () => {
    const selected = questionStore.getSelected();
    if (selected?.answer) copyText(selected.answer, '回答已复制');
});

clearButton.addEventListener('click', () => {
    questionStore.clear();
    activePartialTranscript = '';
    manualInput.value = '';
    renderQuestionList();
    renderSelectedAnswer();
    setRecordingStatus('内容已清空', 'success');
});

outputDiv.addEventListener('scroll', () => {
    const threshold = 80;
    isUserScrolling = outputDiv.scrollHeight - outputDiv.scrollTop - outputDiv.clientHeight > threshold;
});

document.addEventListener('keydown', (event) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    if (event.code === 'KeyA') {
        event.preventDefault();
        if (!startButton.disabled) startButton.click();
        else if (!stopButton.disabled) stopButton.click();
    } else if (event.code === 'KeyC') {
        clearButton.click();
    } else if (event.code === 'KeyF' && !outputButton.disabled) {
        outputButton.click();
        switchPanel('answer');
    }
});

async function loadModelStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/model-config/`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const {label = '服务端模型', model = '', protocol = ''} = await response.json();
        modelStatus.textContent = model ? `${label} · ${model}` : label;
        modelStatus.title = `${protocol || 'server'} 协议，由服务端配置`;
    } catch (error) {
        console.error('读取服务端模型状态失败:', error);
        modelStatus.textContent = '服务端模型 · 未配置';
        modelStatus.title = '请检查 server/config/default_model_profiles.json 和 .env';
    }
}

async function loadAndSetPrompt() {
    try {
        const response = await fetch(`${API_BASE_URL}/prompt/`);
        if (!response.ok) throw new Error('提示词文件加载失败');
        const {prompt = ''} = await response.json();
        const setResponse = await fetch(`${API_BASE_URL}/set_prompt/`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({prompt}),
        });
        if (!setResponse.ok) throw new Error('提示词设置失败');
    } catch (error) {
        console.error('初始化提示词失败:', error);
    }
}

async function saveHistoryAsTXT() {
    try {
        const response = await fetch(`${API_BASE_URL}/history/`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const {history = []} = await response.json();
        const messages = history.filter((entry) => entry.role !== 'system');
        if (!messages.length) {
            setRecordingStatus('当前没有可导出的对话', 'error');
            return;
        }
        const content = messages
            .map((entry) => `${entry.role === 'user' ? '[用户]' : '[AI]'} ${entry.content}`)
            .join('\n\n');
        const url = URL.createObjectURL(new Blob([content], {type: 'text/plain;charset=utf-8'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = `面试对话-${new Date().toISOString().slice(0, 10)}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setRecordingStatus(`已导出 ${messages.length} 条消息`, 'success');
    } catch (error) {
        setRecordingStatus(`导出失败：${error.message}`, 'error');
    }
}

saveTXTButton.addEventListener('click', saveHistoryAsTXT);

function addResponseMessage(message) {
    const payload = parseAsrMessage(message);
    if (payload.kind === 'invalid') {
        console.error('无法解析 ASR 消息:', message);
        return;
    }
    if (payload.kind === 'error') {
        setRecordingStatus(`识别失败：${payload.message}`, 'error');
        return;
    }
    if (payload.kind === 'final') {
        activePartialTranscript = '';
        const question = questionStore.addQuestion(payload.text, 'asr');
        renderQuestionList(true);
        if (question) renderSelectedAnswer();
    } else {
        activePartialTranscript = payload.text.trim();
        renderQuestionList(true);
    }
}

function setRecordingStatus(message, state = 'ready') {
    recordingStatusText.textContent = message;
    recordingStatus.className = `status-pill status-${state}`;
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

startButton.addEventListener('click', async () => {
    startButton.disabled = true;
    stopButton.disabled = true;
    activePartialTranscript = '';
    renderQuestionList();
    setRecordingStatus('正在连接本地识别…', 'processing');

    try {
        const socket = new WebSocket(ASR_WEBSOCKET_URL);
        ws = socket;
        socket.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            if (event.data === 'asr stopped') socket.close(1000, 'ASR stopped');
            else addResponseMessage(event.data);
        };
        socket.onclose = async () => {
            if (!isRecordingStopping) await recorder.stop().catch(console.error);
            if (ws === socket) ws = null;
            resetRecordingControls();
            if (!recordingStatus.classList.contains('status-error')) setRecordingStatus('转写已完成', 'success');
        };
        socket.onerror = () => setRecordingStatus('本地语音服务连接异常', 'error');

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
        setRecordingStatus('正在实时转写', 'recording');
    } catch (error) {
        console.error('启动录音失败:', error);
        setRecordingStatus(`启动失败：${error.message || error}`, 'error');
        await recorder.stop().catch(console.error);
        ws?.close();
        ws = null;
        resetRecordingControls();
    }
});

stopButton.addEventListener('click', async () => {
    if (isRecordingStopping) return;
    isRecordingStopping = true;
    stopButton.disabled = true;
    setRecordingStatus('正在整理最终文本…', 'processing');
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
});

renderQuestionList();
renderSelectedAnswer();
loadModelStatus();
loadAndSetPrompt();
