export function isCurrentChatRequest(activeRequestId, requestId) {
    return activeRequestId === requestId;
}

export function shouldRenderChatOutput(activeQuestionId, selectedQuestionId) {
    return activeQuestionId === selectedQuestionId;
}

export function stopRecorderBeforeAsr(recorder, asr) {
    let recorderStop;
    try {
        recorderStop = recorder.stop();
    } catch {
        recorderStop = undefined;
    }
    return Promise.resolve(recorderStop)
        .catch(() => undefined)
        .then(() => asr.stop())
        .catch(() => undefined);
}
