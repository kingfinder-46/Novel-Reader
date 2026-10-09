const toggleBtn = document.getElementById('toggleBtn');
const speedSlider = document.getElementById('speedSlider');
const speedVal = document.getElementById('speedVal');

let isPlaying = false;

// Sync popup UI state with content script state
async function syncState() {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_STATE' }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.isReading) {
                isPlaying = true;
                toggleBtn.innerText = '⏹';
                toggleBtn.classList.add('playing');
            }
            if (response && response.currentRate) {
                speedSlider.value = response.currentRate;
                speedVal.innerText = parseFloat(response.currentRate).toFixed(1);
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', syncState);

toggleBtn.addEventListener('click', async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    let speed = parseFloat(speedSlider.value);
    let timerMinutes = parseInt(document.getElementById('sleepTimer').value, 10);

    if (!isPlaying) {
        isPlaying = true;
        toggleBtn.innerText = '⏹';
        toggleBtn.classList.add('playing');
        chrome.tabs.sendMessage(tab.id, { action: 'START', initialRate: speed, timerMinutes: timerMinutes });
    } else {
        isPlaying = false;
        toggleBtn.innerText = '▶';
        toggleBtn.classList.remove('playing');
        chrome.tabs.sendMessage(tab.id, { action: 'STOP' });
    }
});

speedSlider.addEventListener('input', async () => {
    let speed = parseFloat(speedSlider.value);
    speedVal.innerText = speed.toFixed(1);
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'CHANGE_SPEED', newRate: speed });
    }
});

document.getElementById('skipBackBtn').addEventListener('click', async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { action: 'SKIP_BACK' });
});

document.getElementById('skipForwardBtn').addEventListener('click', async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { action: 'SKIP_FORWARD' });
});