import test from 'node:test';
import assert from 'node:assert/strict';

let createQuestionStore;
let parseAsrMessage;
try {
    ({createQuestionStore, parseAsrMessage} = await import('../../web/question_store.js'));
} catch (error) {
    assert.fail(`question store module should be importable: ${error.message}`);
}

test('classifies partial, final, and error ASR messages', () => {
    assert.deepEqual(
        parseAsrMessage(JSON.stringify({text: ' 临时内容 ', is_end: false})),
        {kind: 'partial', text: '临时内容'}
    );
    assert.deepEqual(
        parseAsrMessage(JSON.stringify({text: '最终问题', is_end: true})),
        {kind: 'final', text: '最终问题'}
    );
    assert.deepEqual(
        parseAsrMessage(JSON.stringify({event: 'error', message: '识别失败'})),
        {kind: 'error', message: '识别失败'}
    );
    assert.deepEqual(parseAsrMessage('not-json'), {kind: 'invalid'});
});

test('adds trimmed questions and selects the newest question', () => {
    const store = createQuestionStore();

    const first = store.addQuestion('  第一个问题  ', 'asr');
    const second = store.addQuestion('第二个问题', 'manual');

    assert.equal(first.text, '第一个问题');
    assert.equal(first.source, 'asr');
    assert.equal(second.source, 'manual');
    assert.equal(store.getSelected().id, second.id);
    assert.deepEqual(store.getQuestions().map((item) => item.id), [first.id, second.id]);
});

test('ignores empty questions', () => {
    const store = createQuestionStore();

    assert.equal(store.addQuestion('   ', 'asr'), null);
    assert.deepEqual(store.getQuestions(), []);
});

test('keeps an independent answer and status for every question', () => {
    const store = createQuestionStore();
    const first = store.addQuestion('问题一', 'asr');
    const second = store.addQuestion('问题二', 'asr');

    store.setAnswerStatus(first.id, 'loading');
    store.appendAnswer(first.id, '回答');
    store.appendAnswer(first.id, '一');
    store.setAnswerStatus(first.id, 'complete');
    store.selectQuestion(second.id);

    assert.equal(store.getQuestion(first.id).answer, '回答一');
    assert.equal(store.getQuestion(first.id).answerStatus, 'complete');
    assert.equal(store.getSelected().id, second.id);
    assert.equal(store.getSelected().answer, '');
    assert.equal(store.getSelected().answerStatus, 'idle');
});

test('clear removes questions, selection, and cached answers', () => {
    const store = createQuestionStore();
    const question = store.addQuestion('需要清空的问题', 'manual');
    store.appendAnswer(question.id, '需要清空的回答');

    store.clear();

    assert.deepEqual(store.getQuestions(), []);
    assert.equal(store.getSelected(), null);
});
