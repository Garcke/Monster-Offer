import PCMAudioRecorder from './audio_recorder.js';
import {createQuestionStore} from './question_store.js';
import {ModelSettingsController} from './model-settings.js';
import {isCurrentChatRequest, shouldRenderChatOutput, stopRecorderBeforeAsr} from './overlay-session.js';

const api = window.meetingMonster;
if (!api) throw new Error('Meeting Monster desktop API is unavailable');
const meetingMonster = api;

const overlayRoot = document.getElementById('overlayRoot');
const statusText = document.getElementById('overlayStatusText');
const liveDot = document.getElementById('overlayLiveDot');
const protectionButton = document.getElementById('capsuleProtectionToggle');
const settingsButton = document.getElementById('overlaySettingsButton');
const settingsDrawer = document.getElementById('overlaySettingsDrawer');
const settingsClose = document.getElementById('overlaySettingsClose');
const activeModelButton = document.getElementById('overlayActiveModel');
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

const questionStore = createQuestionStore();
const recorder = new PCMAudioRecorder();
let activePartialTranscript = '';
let activeChatRequestId = null;
let activeChatQuestionId = null;
let answerText = '';
let activeAction = 'assist';
let isExpanded = false;
let isRecording = false;
let asrActive = false;

function setStatus(message, state = 'ready') {
    statusText.textContent = message;
    liveDot.classList.toggle('is-recording', state === 'recording');
}

function setAnswerStatus(label, state = 'idle') {
    answerStatus.textContent = label;
    answerStatus.className = `answer-status ${state === 'loading' ? 'is-loading' : state === 'complete' ? 'is-complete' : state === 'error' ? 'is-error' : ''}`;
}

function renderWindowState(state = {}) {
    isExpanded = state.mode === 'expanded';
    overlayRoot.classList.toggle('is-expanded', isExpanded);
    overlayRoot.classList.toggle('is-capsule', !isExpanded);
    expandButton.textContent = isExpanded ? '收起 ⌃' : '展开 ⌄';
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
    const nodes = [];
    questionCount.textContent = `${questions.length} 条`;
    if (!questions.length && !activePartialTranscript) nodes.push(createTextElement('div', 'overlay-empty-state', '开始转写后，当前问题会显示在这里'));
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
        nodes.push(paragraph);
    });
    if (activePartialTranscript) nodes.push(createTextElement('p', 'is-partial', activePartialTranscript));
    transcript.replaceChildren(...nodes);
}

function renderAnswer() {
    const selected = questionStore.getSelected();
    const isSending = activeChatRequestId !== null;
    [assistButton, followupButton, recapButton].forEach((button) => { button.disabled = !selected || isSending; });
    copyButton.disabled = !selected?.answer;
    answerButton.disabled = !selected || isSending;
    if (!selected) {
        setAnswerStatus('等待问题');
        answer.replaceChildren(createTextElement('div', 'overlay-answer-empty', '选择一个问题后，点击 Assist 生成回答'));
        return;
    }
    if (selected.answerStatus === 'loading') {
        setAnswerStatus('回答中', 'loading');
        answer.replaceChildren(createTextElement('div', 'overlay-answer-empty', selected.answer || '正在组织回答…'));
        return;
    }
    if (selected.answerStatus === 'error') {
        setAnswerStatus('回答失败', 'error');
        answer.replaceChildren(createTextElement('div', 'overlay-answer-empty', selected.errorMessage || '请检查当前模型配置'));
        return;
    }
    if (selected.answer) {
        setAnswerStatus('已完成', 'complete');
        answer.textContent = selected.answer;
        return;
    }
    setAnswerStatus('等待生成');
    answer.replaceChildren(createTextElement('div', 'overlay-answer-empty', '当前问题已选中，点击 Assist 生成回答'));
}

function buildPrompt(question, action) {
    if (action === 'followup') return `请基于这个面试问题，给出一个有深度且自然的追问：\n${question}`;
    if (action === 'recap') return `请简洁重述这个面试问题，并提炼出回答重点：\n${question}`;
    return question;
}

async function cancelActiveChat() {
    if (!activeChatRequestId) return;
    const requestId = activeChatRequestId;
    activeChatRequestId = null;
    activeChatQuestionId = null;
    await meetingMonster.chat.cancel(requestId).catch(() => undefined);
}

async function sendQuestionToAI(questionId, action = activeAction) {
    const question = questionStore.getQuestion(questionId);
    if (!question) return;
    await cancelActiveChat();
    questionStore.selectQuestion(question.id);
    questionStore.resetAnswer(question.id);
    questionStore.setAnswerStatus(question.id, 'loading');
    activeChatQuestionId = question.id;
    const requestId = crypto.randomUUID();
    activeChatRequestId = requestId;
    answerText = '';
    renderTranscript();
    renderAnswer();
    try {
        await meetingMonster.chat.send(requestId, buildPrompt(question.text, action));
    } catch (error) {
        if (!isCurrentChatRequest(activeChatRequestId, requestId)) return;
        questionStore.setAnswerStatus(question.id, 'error', error.message || '无法请求 AI 回复');
        activeChatRequestId = null;
        activeChatQuestionId = null;
        renderAnswer();
    } finally {
        if (isCurrentChatRequest(activeChatRequestId, requestId)) renderAnswer();
    }
}

function updatePartialTranscript(text) {
    activePartialTranscript = String(text || '').trim();
    renderTranscript();
}

function commitFinalQuestion(text) {
    activePartialTranscript = '';
    const question = questionStore.addQuestion(text, 'asr');
    if (question) {
        renderTranscript();
        renderAnswer();
    }
}

function applyAsrStatus(status = {}) {
    const message = status.message;
    if (status.state === 'recording') {
        isRecording = true;
        asrActive = true;
        startButton.disabled = true;
        stopButton.disabled = false;
        setStatus(message || '正在实时转写', 'recording');
    } else if (status.state === 'connecting' || status.state === 'stopping') {
        setStatus(message || (status.state === 'stopping' ? '正在停止转写' : '正在连接转写服务'));
    } else if (status.state === 'error') {
        isRecording = false;
        asrActive = false;
        startButton.disabled = false;
        stopButton.disabled = true;
        setStatus(message || '远程转写失败，请检查 Python 服务', 'error');
        recorder.stop().catch(() => undefined);
    } else if (status.state === 'idle') {
        isRecording = false;
        asrActive = false;
        startButton.disabled = false;
        stopButton.disabled = true;
        setStatus(message || '转写已停止');
    }
}

async function startRecording() {
    startButton.disabled = true;
    stopButton.disabled = true;
    activePartialTranscript = '';
    renderTranscript();
    try {
        const settings = await meetingMonster.settings.getStatus();
        if (!settings.configured) {
            openSettingsDrawer();
            throw new Error('请先配置 Python 服务');
        }
        const sampleRate = await recorder.prepare((chunk) => meetingMonster.asr.writePcm(chunk));
        await meetingMonster.asr.start(sampleRate);
        asrActive = true;
        recorder.start();
        isRecording = true;
        startButton.disabled = true;
        stopButton.disabled = false;
        setStatus('正在实时转写', 'recording');
    } catch (error) {
        await recorder.stop().catch(() => undefined);
        await meetingMonster.asr.stop().catch(() => undefined);
        isRecording = false;
        asrActive = false;
        startButton.disabled = false;
        stopButton.disabled = true;
        setStatus(error.message || '无法开始转写', 'error');
    }
}

async function stopRecording() {
    if (!isRecording && !asrActive && stopButton.disabled) return;
    stopButton.disabled = true;
    setStatus('正在停止转写');
    try {
        try {
            await recorder.stop();
        } finally {
            await meetingMonster.asr.stop();
        }
        setStatus('转写已停止');
    } catch (error) {
        setStatus(error.message || '停止转写失败', 'error');
    } finally {
        isRecording = false;
        asrActive = false;
        startButton.disabled = false;
        stopButton.disabled = true;
    }
}

function submitInput(event) {
    event?.preventDefault();
    const text = input.value.trim();
    if (!text) {
        const selected = questionStore.getSelected();
        if (selected) sendQuestionToAI(selected.id, activeAction);
        return;
    }
    const question = questionStore.addQuestion(text, 'manual');
    input.value = '';
    if (question) {
        renderTranscript();
        renderAnswer();
        sendQuestionToAI(question.id, activeAction);
    }
}

function copySelectedAnswer() {
    const selected = questionStore.getSelected();
    if (!selected?.answer) return;
    navigator.clipboard.writeText(selected.answer)
        .then(() => setStatus('回答已复制'))
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

function openSettingsDrawer() {
    settingsDrawer.hidden = false;
    settingsButton.setAttribute('aria-expanded', 'true');
    if (!isExpanded) meetingMonster.window.setExpanded(true).then(renderWindowState).catch(() => undefined);
    settingsClose.focus();
}

function closeSettingsDrawer() {
    settingsDrawer.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false');
    settingsButton.focus();
}

function renderActiveModel(profile) {
    activeModelButton.textContent = profile?.label ? `当前：${profile.label}` : '未选择模型';
}

const settingsController = new ModelSettingsController({
    api: meetingMonster,
    elements: {
        serverBaseUrl: document.getElementById('serverBaseUrl'), serverAdminToken: document.getElementById('serverAdminToken'),
        serverSaveButton: document.getElementById('serverSaveButton'), serverTestButton: document.getElementById('serverTestButton'),
        serverClearButton: document.getElementById('serverClearButton'), serverStatus: document.getElementById('serverStatus'),
        modelList: document.getElementById('modelList'), modelForm: document.getElementById('modelForm'),
        modelProfileId: document.getElementById('modelProfileId'), modelLabel: document.getElementById('modelLabel'),
        modelProtocol: document.getElementById('modelProtocol'), modelBaseUrl: document.getElementById('modelBaseUrl'),
        modelName: document.getElementById('modelName'), modelApiKey: document.getElementById('modelApiKey'),
        modelApiKeyRequired: document.getElementById('modelApiKeyRequired'), modelMaxTokens: document.getElementById('modelMaxTokens'),
        modelTemperature: document.getElementById('modelTemperature'), modelSaveButton: document.getElementById('modelSaveButton'),
        modelTestButton: document.getElementById('modelTestButton'), modelCancelButton: document.getElementById('modelCancelButton'),
        modelNewButton: document.getElementById('modelNewButton'), modelStatus: document.getElementById('modelStatus'),
    },
    onActiveModelChanged: renderActiveModel,
});

const unsubscribeChat = meetingMonster.chat.onEvent((event) => {
    if (event.requestId !== activeChatRequestId) return;
    const questionId = activeChatQuestionId;
    const selectedQuestionId = questionStore.getSelected()?.id;
    const renderForSelectedQuestion = shouldRenderChatOutput(questionId, selectedQuestionId);
    if (event.type === 'chunk') {
        answerText += event.text || '';
        questionStore.appendAnswer(questionId, event.text || '');
        if (renderForSelectedQuestion) {
            answer.textContent = answerText;
            setAnswerStatus('回答中', 'loading');
        }
    } else if (event.type === 'done') {
        questionStore.setAnswerStatus(questionId, 'complete');
        activeChatRequestId = null;
        activeChatQuestionId = null;
        renderTranscript();
        if (renderForSelectedQuestion) {
            setAnswerStatus('已完成', 'complete');
            renderAnswer();
        }
    } else {
        questionStore.setAnswerStatus(questionId, 'error', event.text || '回答失败');
        activeChatRequestId = null;
        activeChatQuestionId = null;
        if (renderForSelectedQuestion) {
            setAnswerStatus(event.text || '回答失败', 'error');
            renderAnswer();
        }
    }
});

const unsubscribeAsrStatus = meetingMonster.asr.onStatus((status) => applyAsrStatus(status));
const unsubscribeAsrResult = meetingMonster.asr.onResult((event) => {
    if (event.type === 'partial') updatePartialTranscript(event.text);
    if (event.type === 'final') commitFinalQuestion(event.text);
    if (event.type === 'error') {
        isRecording = false;
        asrActive = false;
        startButton.disabled = false;
        stopButton.disabled = true;
        recorder.stop().catch(() => undefined);
        setStatus(event.text || '远程转写失败', 'error');
    }
});

expandButton.addEventListener('click', () => meetingMonster.window.setExpanded(!isExpanded).then(renderWindowState).catch(() => undefined));
hideButton.addEventListener('click', () => meetingMonster.window.hide().catch(() => undefined));
settingsButton.addEventListener('click', openSettingsDrawer);
activeModelButton.addEventListener('click', openSettingsDrawer);
settingsClose.addEventListener('click', closeSettingsDrawer);
protectionButton.addEventListener('click', async () => {
    protectionButton.disabled = true;
    try {
        const current = await meetingMonster.privacy.getStatus();
        renderProtectionStatus(await meetingMonster.privacy.setCaptureProtection(current.captureProtectionEnabled !== true));
    } catch {
        renderProtectionStatus({captureProtection: 'failed', captureProtectionEnabled: false});
    }
});
startButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);
clearButton.addEventListener('click', async () => {
    await cancelActiveChat();
    if (isRecording || asrActive || !stopButton.disabled) await stopRecording();
    questionStore.clear();
    activePartialTranscript = '';
    answerText = '';
    input.value = '';
    setAction('assist', 'What should I say?');
    renderTranscript();
    renderAnswer();
    setStatus('内容已清空');
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
    if (event.key === 'Escape' && !settingsDrawer.hidden) {
        closeSettingsDrawer();
        return;
    }
    if (event.key === 'Escape' && isExpanded) meetingMonster.window.setExpanded(false).then(renderWindowState).catch(() => undefined);
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (event.code === 'KeyA') {
        event.preventDefault();
        if (!startButton.disabled) startButton.click();
        else if (!stopButton.disabled) stopButton.click();
    }
});
window.addEventListener('beforeunload', () => {
    if (activeChatRequestId) meetingMonster.chat.cancel(activeChatRequestId).catch(() => undefined);
    stopRecorderBeforeAsr(recorder, meetingMonster.asr);
    unsubscribeChat();
    unsubscribeAsrStatus();
    unsubscribeAsrResult();
    unsubscribeWindowState();
    unsubscribePrivacyStatus();
});

const unsubscribeWindowState = meetingMonster.window.onState(renderWindowState);
meetingMonster.window.getState().then(renderWindowState).catch(() => renderWindowState({mode: 'capsule'}));
const unsubscribePrivacyStatus = meetingMonster.privacy.onStatus(renderProtectionStatus);
meetingMonster.privacy.getStatus().then(renderProtectionStatus).catch(() => renderProtectionStatus({captureProtection: 'failed'}));
settingsController.bind();
settingsController.refreshConnection().catch(() => undefined);
settingsController.refreshModels().then((profiles) => renderActiveModel(profiles.find((profile) => profile.active))).catch(() => undefined);
renderTranscript();
renderAnswer();
