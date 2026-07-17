const ANSWER_STATUSES = new Set(['idle', 'loading', 'complete', 'error']);

export function parseAsrMessage(message) {
    let payload;
    try {
        payload = JSON.parse(message);
    } catch {
        return {kind: 'invalid'};
    }

    if (payload.event === 'error') {
        return {kind: 'error', message: payload.message || '未知错误'};
    }
    if (typeof payload.text !== 'string') return {kind: 'invalid'};
    return {
        kind: payload.is_end ? 'final' : 'partial',
        text: payload.text.trim(),
    };
}

export function createQuestionStore() {
    let questions = [];
    let selectedQuestionId = null;
    let nextId = 1;

    function getQuestion(id) {
        return questions.find((item) => item.id === id) || null;
    }

    function addQuestion(text, source = 'asr') {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) return null;

        const question = {
            id: `question-${nextId++}`,
            text: normalizedText,
            source,
            answer: '',
            answerStatus: 'idle',
            errorMessage: '',
        };
        questions.push(question);
        selectedQuestionId = question.id;
        return question;
    }

    function selectQuestion(id) {
        if (!getQuestion(id)) return null;
        selectedQuestionId = id;
        return getSelected();
    }

    function getSelected() {
        return selectedQuestionId ? getQuestion(selectedQuestionId) : null;
    }

    function getQuestions() {
        return questions;
    }

    function setAnswerStatus(id, status, errorMessage = '') {
        if (!ANSWER_STATUSES.has(status)) throw new Error(`Unknown answer status: ${status}`);
        const question = getQuestion(id);
        if (!question) return null;
        question.answerStatus = status;
        question.errorMessage = errorMessage;
        return question;
    }

    function resetAnswer(id) {
        const question = getQuestion(id);
        if (!question) return null;
        question.answer = '';
        question.errorMessage = '';
        question.answerStatus = 'idle';
        return question;
    }

    function appendAnswer(id, chunk) {
        const question = getQuestion(id);
        if (!question) return null;
        question.answer += String(chunk || '');
        return question;
    }

    function clear() {
        questions = [];
        selectedQuestionId = null;
        nextId = 1;
    }

    return {
        addQuestion,
        appendAnswer,
        clear,
        getQuestion,
        getQuestions,
        getSelected,
        resetAnswer,
        selectQuestion,
        setAnswerStatus,
    };
}
