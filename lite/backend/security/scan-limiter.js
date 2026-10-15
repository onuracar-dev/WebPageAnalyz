class ScanLimiter {
    constructor({
        hostCooldownMs = 10 * 60 * 1000,
        dailyScanLimit = 200,
        nowFn = () => Date.now()
    } = {}) {
        this.hostCooldownMs = hostCooldownMs;
        this.dailyScanLimit = dailyScanLimit;
        this.nowFn = nowFn;
        this.hostLastScanned = new Map();
        this.dailyCount = 0;
        this.currentUtcDay = this.getUtcDayKey(this.nowFn());
    }

    getUtcDayKey(timestamp) {
        const d = new Date(timestamp);
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    _refreshDay() {
        const todayKey = this.getUtcDayKey(this.nowFn());
        if (todayKey !== this.currentUtcDay) {
            this.currentUtcDay = todayKey;
            this.dailyCount = 0;
        }
    }

    getHostRemainingCooldownMs(hostname) {
        if (!hostname) return 0;
        const normalized = String(hostname).toLowerCase();
        const lastTime = this.hostLastScanned.get(normalized);
        if (!lastTime) return 0;
        const now = this.nowFn();
        const elapsed = now - lastTime;
        return Math.max(0, this.hostCooldownMs - elapsed);
    }

    isHostInCooldown(hostname) {
        return this.getHostRemainingCooldownMs(hostname) > 0;
    }

    getDailyRemaining() {
        this._refreshDay();
        return Math.max(0, this.dailyScanLimit - this.dailyCount);
    }

    isDailyLimitReached() {
        this._refreshDay();
        return this.dailyCount >= this.dailyScanLimit;
    }

    recordScan(hostname) {
        this._refreshDay();
        this.dailyCount += 1;
        if (hostname) {
            this.hostLastScanned.set(String(hostname).toLowerCase(), this.nowFn());
        }
    }

    reset() {
        this.hostLastScanned.clear();
        this.dailyCount = 0;
        this.currentUtcDay = this.getUtcDayKey(this.nowFn());
    }
}

module.exports = { ScanLimiter };
