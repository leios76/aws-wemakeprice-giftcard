const request = require('request');
const config = require('config');
const cheerio = require('cheerio');
const async = require('async');
const AWS = require('aws-sdk');

AWS.config.update({
    region: 'ap-northeast-2',
    endpoint: "http://dynamodb.ap-northeast-2.amazonaws.com"
});

//const dynamodb = new AWS.DynamoDB();
const docClient = new AWS.DynamoDB.DocumentClient();

var now;

var req = request.defaults({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'ko,en-US;q=0.8,en;q=0.6'
    },
    jar: true,
    gzip: true,
    followAllRedirects: true,
    //encoding: null
});

var captchaId = '';
var saltValue = '';
var loginToken = '';

var start = function (callback) {
    callback(null, {
        data: {
            items: [],
        },
        message: "",
        loggedIn: false,
    });
};

var requestListPage = function (result, callback) {
    var option = {
        //uri: 'http://www.wemakeprice.com/main/103900/103912',
        uri: 'http://www.wemakeprice.com/main/get_deal_more/103900/103912',
        method: 'GET',
        json: true,
        qs: {
        }
    };

    req(option, function (err, response, body) {
        result.response = response;
        result.body = body;

        console.log("Parsing Item List");
        if (!err) {
            var $ = cheerio.load(body.html);
            result.data.items = $('li').map((index, element) => {
                var item = {};

                var href = $("span.type03 > a", element).attr('href').split('?')[0];
                if (href.startsWith('http')) {
                    item.url = href;
                } else {
                    if (href.endsWith('/103900/')) {
                        item.url = 'http://www.wemakeprice.com' + href.replace(/\/103900\//g, '');
                    } else {
                        item.url = 'http://www.wemakeprice.com' + href;
                    }
                }
                item.price = parseInt($("span.type03 > a > span.box_desc > span.txt_info > span.price > span.sale", element).text().replace(/,/g, ''), 10);
                item.title = $("span.type03 > a > span.box_desc > strong.tit_desc", element).text();

                if (item.price < 88000) {
                    return null;
                }
                if (item.price > 101000) {
                    return null;
                }
                if (body.html.indexOf('btn_buy_end') > -1) {
                    return null;
                }
                return item;
            }).get();
        }

        callback(err, result);
    });
};

var parseItem = function (item, callback) {
    var option = {
        uri: item.url,
        method: 'GET',
        qs: {
        }
    };

    req(option, function (err, response, body) {
        if (!err) {
            var matches = body.match(/(var aCouponList = .*)/);
            if (matches && matches.length > 1) {
                eval(matches[1]);

                item.couponList = aCouponList.map((value, index, array) => {
                    if (value.publish_start_time < now && now <= value.publish_end_time && value.usable_time < now && now <= value.expire_time) {
                        return {
                            coupon_value: value.coupon_value,
                            max_discount_price: value.max_discount_price,
                            min_payment_amount: value.min_payment_amount,
                            //publish_start_time: value.publish_start_time,
                            //publish_end_time: value.publish_end_time,
                            //usable_time: value.usable_time,
                            //expire_time: value.expire_time,
                        };
                    } else {
                        return null;
                    }
                });
            } else {
                console.log("Pattern not found!");
            }
        }
        item.lowestPrice = item.couponList.reduce((prev, curr) => {
            var curr_price = item.price;
            for (var i = 0; i < 20; i++) {
                if (curr.min_payment_amount < (item.price * i)) {
                    curr_price = Math.floor(((item.price * i) - curr.coupon_value) / i);
                    break;
                }
            }
            if (prev > curr_price) {
                return curr_price;
            } else {
                return prev;
            }
        }, item.price);
        callback(err);
    });
};

var getProductId = function (item) {
    if (item.title.indexOf("컬쳐랜드") > -1) {
        return "컬쳐랜드";
    }
    if (item.title.indexOf("해피머니") > -1) {
        return "해피머니";
    }
    if (item.title.indexOf("도서문화상품권") > -1) {
        return "도서문화상품권";
    }
    if (item.title.indexOf("롯데") > -1) {
        return "롯데";
    }
    if (item.title.indexOf("신세계") > -1) {
        return "신세계";
    }
    
    return "";
};

var updateStatistics = function (item, callback) {
    var productId = getProductId(item);
    var lowPrices = {
        _007d_price: item.price,
        _030d_price: item.price,
        _365d_price: item.price,
    };

    if (productId.length === 0) {
        callback(lowPrices);
        return;
    }

    var getParams = {
        TableName: 'webdata',
        Key: {
            site: productId,
            timestamp: 0,
        }
    };

    console.log(`Get Statistics for ${productId}`);
    docClient.get(getParams, (err, res) => {
        var data = [];
        if (!err) {
            console.log(JSON.stringify(res));
            if (res && res.Item && res.Item.data) {
                data = res.Item.data;
            }
        }
        data.push({ ts: now, price: item.lowestPrice });

        lowPrices = data.reduce((prev, curr) => {
            // 7일 이내 데이터이면
            if (now < curr.ts + 7 * 24 * 60 * 60) {
                if (curr.price < prev._007d_price) {
                    prev._007d_price = curr.price;
                }
            }
            // 30일 이내 데이터이면
            if (now < curr.ts + 30 * 24 * 60 * 60) {
                if (curr.price < prev._030d_price) {
                    prev._030d_price = curr.price;
                }
            }
            // 1년 이내 데이터이면
            if (now < curr.ts + 365 * 24 * 60 * 60) {
                if (curr.price < prev._365d_price) {
                    prev._365d_price = curr.price;
                }
            }
            return prev;
        }, lowPrices);

        data = data.map((d) => {
            // 1년 이내 데이터이면
            if (now < d.ts + 365 * 24 * 60 * 60) {
                return d;
            }
        });

        var putParams = {
            TableName: 'webdata',
            Item: {
                site: productId,
                timestamp: 0,
                ttl: now + 30 * 24 * 60 * 60,
                data: data
            }
        };

        console.log("Updating Statistics");
        docClient.put(putParams, (err, res) => {
            if (!err) {
                console.log(JSON.stringify(res));
            }
            callback(lowPrices);
        });
    });
};

var processItem = function (result, saved, item, callback) {
    console.log(`Checking item ${item.title} : ${item.url}`);

    var productId = getProductId(item);
    var found = saved.items.reduce((f, curr) => {
        if (f) {
            return f;
        } else {
            if (curr.url === item.url) {
                return curr;
            }
        }
    }, null);

    if (!found) {
        console.log(`New item ${item.title}`);
        updateStatistics(item, (lowPrices) => {
            result.message += `[신규 상품 등록]\n품명: ${item.title}\nURL: ${item.url}\n가격: ${item.price}\n최저가: ${item.lowestPrice}\n\n`;
            callback(null);
        });
    } else {
        if (item.lowestPrice !== found.lowestPrice) {
            console.log(`New lowest price ${item.title} => ${item.lowestPrice}`);
            updateStatistics(item, (lowPrices) => {
                result.message += `[가격 변동]\n품명: ${item.title}\nURL: ${item.url}\n가격: ${item.price}\n최저가: ${found.lowestPrice} => ${item.lowestPrice}\n주최저가: ${lowPrices._007d_price}\n월최저가: ${lowPrices._030d_price}\n년최저가: ${lowPrices._365d_price}\n\n`;
                callback(null);
            });
        } else {
            callback(null);
        }
    }

};

var makeReport = function (result, callback) {
    var queryParams = {
        TableName: 'webdata',
        KeyConditionExpression: "#site = :site",
        ScanIndexForward: false,
        Limit: 1,
        ExpressionAttributeNames: {
            "#site": "site"
        },
        ExpressionAttributeValues: {
            ":site": 'wemakeprice-collect'
        }
    };

    console.log("Making Report");
    docClient.query(queryParams, (err, res) => {
        if (!err) {
            var saved = { items: [] };
            if (res.Items.length > 0 && res.Items[0].data) {
                saved = res.Items[0].data;
            }
            async.eachSeries(result.data.items, (item, inner_callback) => {
                processItem(result, saved, item, inner_callback);
            }, function (err) {
                callback(err, result);
            });
        } else {
            callback(err, result);
        }
    });
};

var saveReport = function (result, callback) {
    var putParams = {
        TableName: 'webdata',
        Item: {
            site: 'wemakeprice-collect',
            timestamp: now,
            ttl: now + 30 * 24 * 60 * 60,
            data: result.data
        }
    };

    console.log("Saving Report");
    docClient.put(putParams, (err, res) => {
        if (!err) {
            console.log(JSON.stringify(res));
        }
        callback(err, result);
    });
};

var notifyReport = function (result, callback) {
    console.log("Notify Report");
    if (result.message.length > 0) {
        var telegramConfig = config.get('telegram');
        var option = {
            uri: `https://api.telegram.org/${telegramConfig.bot_id}:${telegramConfig.token}/sendMessage`,
            method: 'POST',
            json: true,
            body: {
                'chat_id': telegramConfig.chat_id,
                'text': result.message
            }
        };

        req(option, function (err, response, body) {
            if (!err && (body && !body.ok)) {
                console.log(body);
                callback("Send Message Fail", result);
            } else {
                callback(err, result);
            }
        });
    } else {
        callback(null, result);
    }
};

exports.handler = function (event, context, callback) {
    now = Math.floor(Date.now() / 1000);
    async.waterfall([
        start,
        requestListPage,
        function (result, callback) {
            async.eachLimit(result.data.items, 5, parseItem, function (err) {
                callback(err, result);
            });
        },
        makeReport,
        saveReport,
        notifyReport,
    ], function (err, result) {
        if (err) {
            console.log(err);
        }
    });

    if (callback) {
        callback(null, 'Success');
    }
};
