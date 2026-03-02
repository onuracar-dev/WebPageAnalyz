const { runYellowLab } = require('./analyzers/yellowlab');

runYellowLab('https://example.com')
    .then(res => console.log('YellowLab Success:', res))
    .catch(err => console.error('YellowLab Error:', err));
