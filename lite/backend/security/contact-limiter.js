class ContactLimiter {
    constructor({
        dailyContactLimit = 50,
        nowFn = () => Date.now()
    } = {}) {
        this.dailyContactLimit = dailyContactLimit;
        this.nowFn = nowFn;
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

    getDailyRemaining() {
        this._refreshDay();
        return Math.max(0, this.dailyContactLimit - this.dailyCount);
    }

    isDailyLimitReached() {
        this._refreshDay();
        return this.dailyCount >= this.dailyContactLimit;
    }

    recordSubmission() {
        this._refreshDay();
        this.dailyCount += 1;
    }

    reset() {
        this.dailyCount = 0;
        this.currentUtcDay = this.getUtcDayKey(this.nowFn());
    }
}

module.exports = { ContactLimiter };
