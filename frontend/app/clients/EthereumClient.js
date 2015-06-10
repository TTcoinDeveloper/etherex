var _ = require("lodash");
var utils = require("../js/utils");
var fixtures = require("../js/fixtures");

var bigRat = require('big-rational');

require('es6-promise').polyfill();

if (typeof web3 === 'undefined') {
    var web3 = require('web3');
    window.web3 = web3;
}

web3.padDecimal = function (string, chars) {
    string = web3.fromDecimal(string).substr(2);
    return Array(chars - string.length + 1).join("0") + string;
};

var EthereumClient = function(params) {
    try {
        web3.setProvider(new web3.providers.HttpProvider('http://' + params.host));

        var ContractABI = web3.eth.contract(fixtures.contract_desc);
        var contract = ContractABI.at(params.address);
    }
    catch(e) {
        console.log("Some web3.js error...", String(e));
    }

    this.filters = {};

    this.startMonitoring = function(callback) {
      this.filters.latest = web3.eth.filter('latest');
      this.filters.latest.watch(function (err, log) {
        // if (err) utilities.error(err);
        callback();
      });
    };

    this.stopMonitoring = function() {
      _.each(this.filters, function(filter) {
        filter.stopWatching();
      });
    };

    this.isAvailable = function() {
      // attempt an RPC call that should fail if the daemon is unreachable.
      try {
        return web3.net.listening;
      } catch(err) {
        return false;
      }
    };

    this.blockChainAge = function() {
      if (web3.net.listening) {
        var blockNumber = web3.eth.blockNumber;
        var blockTimeStamp = web3.eth.getBlock(blockNumber).timestamp;
        var currentTimeStamp = new Date().getTime() / 1000;

        return currentTimeStamp - blockTimeStamp;
      }
    };

    // Loading methods

    this.loadAddresses = function(success, failure) {
        var loadPromise = new Promise(function (resolve, reject) {
            try {
                var accounts = web3.eth.accounts;

                if (!accounts || accounts.length === 0)
                    reject("No accounts were found on this Ethereum node.");

                resolve(accounts);
            }
            catch (e) {
                reject("Unable to load addresses, are you running an Ethereum node? Please load this URL in Mist, AlethZero, or with a geth/eth node running with JSONRPC enabled.");
                // reject("Error loading accounts: " + String(e));
            }
        });

        loadPromise.then(function (accounts) {
            success(accounts);
        }, function (e) {
            failure(String(e));
        });
    };

    this.loadMarkets = function(user, success, failure) {
        try {
            var last = _.parseInt(contract.get_last_market_id.call().toString());

            // console.log("LAST MARKET ID: ", last);

            if (!last) {
                failure("No market found, seems like contracts are missing.");
                return;
            }

            var markets = [];

            var favs = localStorage.getItem('favorites');
            var favorites = JSON.parse(favs);

            if (!favorites || typeof(favorites) != 'object')
                favorites = [];
            // console.log('FAVORITES', favorites);

            for (var i = 1; i < last + 1; i++) {
                try {
                    var market = contract.get_market.call(i);
                    // console.log("Market from ABI:", market);

                    var id = _.parseInt(market[0].toString());
                    var name = web3.toAscii(web3.fromDecimal(market[1].toString()));
                    var address = web3.fromDecimal(market[2]);
                    var decimals = _.parseInt(market[3].toString());
                    var precision = _.parseInt(market[4].toString());
                    var minimum = _.parseInt(market[5].toString());
                    var lastPrice = null;
                    if (market[6] != 1)
                        lastPrice = parseFloat(bigRat(market[6].toString()).divide(bigRat(Math.pow(10, market[4].toString().length - 1))).toDecimal());
                    var owner = web3.fromDecimal(market[7]);
                    var block = _.parseInt(market[8].toString());
                    var total_trades = _.parseInt(market[9].toString());
                    var category = _.parseInt(market[10].toString());

                    // console.log(id, name, address, decimals, precision, minimum, category, lastPrice, owner, block, total_trades);

                    var SubContractABI = web3.eth.contract(fixtures.sub_contract_desc);
                    var subcontract = SubContractABI.at(address);
                    var balance = subcontract.balance.call(user.id).toString();

                    var favorite = false;
                    if (favorites.length > 0 && _.indexOf(favorites, id) >= 0)
                        favorite = true;

                    markets.push({
                        id: id,
                        name: name,
                        address: address,
                        category: category,
                        decimals: decimals,
                        minimum: minimum,
                        precision: precision,
                        lastPrice: lastPrice,
                        owner: owner,
                        block: block,
                        total_trades: total_trades,
                        balance: _.parseInt(balance),
                        favorite: favorite
                    });
                }
                catch(e) {
                    failure("Unable to load market " + i + ": " + String(e));
                }
            }

            if (markets)
                success(markets);
            else
                failure("No market to load.");
        }
        catch (e) {
            failure("Unable to load markets: " + String(e));
        }
    };

    this.loadTrades = function(flux, market, progress, success, failure) {
        try {
            // Set defaultBlock to 'pending' trade IDs
            web3.eth.defaultBlock = 'pending';

            var trade_ids = contract.get_trade_ids.call(market.id);

            if (!trade_ids || trade_ids.length === 0) {
                failure("No trades found");
                return;
            }

            var total = trade_ids.length;
            // console.log("TOTAL TRADES: ", total);

            var tradePromises = [];

            for (var i = 0; i < total; i++) {
                var tradePromise = new Promise(function (resolve, reject) {
                    var id = trade_ids[i];
                    var p = i;

                    var trade = contract.get_trade.call(id, 'latest');
                    // console.log("Trade from ABI:", trade);

                    try {
                        tradeId = web3.fromDecimal(trade[0]);
                        var ref = trade[7];

                        // Resolve on filled trades
                        if (tradeId == "0x0" || ref == "0"){
                            resolve({});
                            return;
                        }

                        var status = 'mined';

                        var tradeExists = web3.eth.getStorageAt(fixtures.addresses.etherex, web3.fromDecimal(ref), 'latest');

                        if (tradeExists == "0x0")
                            status = 'pending';
                        else
                            status = 'mined';

                        var type = _.parseInt(trade[1].toString());
                        // var marketid = _.parseInt(trade[2].toString());
                        var amountPrecision = Math.pow(10, market.decimals);
                        var precision = market.precision;

                        // console.log("Loading trade " + id + " for market " + market.name);

                        var amount = bigRat(trade[3].toString()).divide(amountPrecision).valueOf();
                        var price = bigRat(trade[4].toString()).divide(precision).valueOf();

                        // Update progress
                        progress({percent: (p + 1) / total * 100 });

                        resolve({
                            id: tradeId,
                            type: type == 1 ? 'buys' : 'sells',
                            price: price,
                            amount: amount,
                            total: amount * price,
                            owner: web3.fromDecimal(trade[5].toString()),
                            market: {
                                id: market.id,
                                name: market.name
                            },
                            status: status,
                            block: _.parseInt(trade[6].toString())
                        });
                    }
                    catch(e) {
                        reject(e);
                    }
                });
                tradePromises.push(tradePromise);
            }

            Promise.all(tradePromises).then(function (trades) {
                // console.log("TRADES", trades);
                success(trades);
            }, function(e) {
                failure("Could not load all trades: " + String(e));
            });
        }
        catch (e) {
            failure("Unable to load trades: " + String(e));
        }
    };

    this.loadPrices = function(market, success, failure) {
        // console.log("Loading prices...");

        try {
            var prices_filter = contract.log_price({
              market: market.id
            }, {
              fromBlock: 'earliest',
              toBlock: 'latest'
            });
            var pricelogs = prices_filter.get();
            // console.log("PRICE CHANGES: ", pricelogs);

            var prices = [];
            var amountPrecision = Math.pow(10, market.decimals);
            var precision = market.precision;

            for (var i = pricelogs.length - 1; i >= 0; i--) {
                var pricelog = {
                    timestamp: _.parseInt(web3.toDecimal(pricelogs[i].args.timestamp)),
                    type: _.parseInt(web3.toDecimal(pricelogs[i].args.type)),
                    price: bigRat(web3.toDecimal(pricelogs[i].args.price)).divide(precision).valueOf(),
                    amount: bigRat(web3.toDecimal(pricelogs[i].args.amount)).divide(amountPrecision).valueOf()
                };
                prices.push(pricelog);
            }

            // console.log("PRICES", prices);

            success(prices);
        }
        catch (e) {
            failure("Unable to load prices: " + String(e));
        }
    };

    this.loadTransactions = function(user, market, success, failure) {
        // console.log("Loading transactions...");

        try {
            var txs = [];
            var amount = '';
            var price = '';
            var total = '';

            // Get deposits
            var tx_filter = contract.log_deposit({
              sender: user.id
            }, {
              fromBlock: 'earliest',
              toBlock: 'latest'
            });
            var txlogs = tx_filter.get();
            // console.log("TRANSACTIONS: ", txlogs);
            for (var i = txlogs.length - 1; i >= 0; i--)
                txs.push({
                  hash: txlogs[i].transactionHash || txlogs[i].hash,
                  type: 'deposit',
                  number: txlogs[i].number,
                  block: txlogs[i].blockNumber,
                  inout: 'out',
                  from: web3.fromDecimal(txlogs[i].args.sender),
                  to: fixtures.addresses.etherex,
                  amount: txlogs[i].args.amount.valueOf(),
                  market: _.parseInt(txlogs[i].args.market.valueOf()),
                  price: 'N/A',
                  total: 'N/A',
                  result: 'OK'
                });

            // Get withdrawals
            tx_filter = contract.log_withdraw({
              address: user.id
            }, {
              fromBlock: 'earliest',
              toBlock: 'latest'
            });
            txlogs = tx_filter.get();
            // console.log("TRANSACTIONS: ", txlogs);
            for (i = txlogs.length - 1; i >= 0; i--)
                txs.push({
                  hash: txlogs[i].transactionHash || txlogs[i].hash,
                  type: 'withdraw',
                  number: txlogs[i].number,
                  block: txlogs[i].blockNumber,
                  inout: 'in',
                  from: fixtures.addresses.etherex,
                  to: web3.fromDecimal(txlogs[i].args.address),
                  amount: txlogs[i].args.amount.valueOf(),
                  market: _.parseInt(txlogs[i].args.market.valueOf()),
                  price: 'N/A',
                  total: 'N/A',
                  result: 'OK'
                });

            // Get cancelations
            tx_filter = contract.log_cancel({
              sender: user.id
            }, {
              fromBlock: 'earliest',
              toBlock: 'latest'
            });
            txlogs = tx_filter.get();
            // console.log("TRANSACTIONS: ", txlogs);
            for (i = txlogs.length - 1; i >= 0; i--) {
                amount = txlogs[i].args.amount.valueOf();
                price = bigRat(txlogs[i].args.price.valueOf()).divide(market.precision).valueOf();
                total = bigRat(amount).divide(Math.pow(10, market.decimals)).multiply(price).multiply(fixtures.ether);

                txs.push({
                  hash: txlogs[i].transactionHash || txlogs[i].hash,
                  type: 'cancel',
                  number: txlogs[i].number,
                  block: txlogs[i].blockNumber,
                  inout: 'in',
                  from: web3.fromDecimal(txlogs[i].args.sender),
                  to: fixtures.addresses.etherex,
                  amount: amount,
                  market: _.parseInt(txlogs[i].args.market.valueOf()),
                  price: price,
                  total: utils.formatBalance(total),
                  result: 'OK'
                });
            }

            // Get added trades
            tx_filter = contract.log_add_tx({
              sender: user.id
            }, {
              fromBlock: 'earliest',
              toBlock: 'latest'
            });
            txlogs = tx_filter.get();
            // console.log("TRANSACTIONS: ", txlogs);
            for (i = txlogs.length - 1; i >= 0; i--) {
                amount = txlogs[i].args.amount.valueOf();
                price = bigRat(txlogs[i].args.price.valueOf()).divide(market.precision).valueOf();
                total = bigRat(amount).divide(Math.pow(10, market.decimals)).multiply(price).multiply(fixtures.ether);

                txs.push({
                  hash: txlogs[i].transactionHash || txlogs[i].hash,
                  type: txlogs[i].args.type.valueOf() == 1 ? 'buy' : 'sell',
                  number: txlogs[i].number,
                  block: txlogs[i].blockNumber,
                  // inout: (_.parseInt(web3.toDecimal(txlogs[i].args.type)) == 1 ? 'in' : 'out'),
                  inout: 'out',
                  from: web3.fromDecimal(txlogs[i].args.sender),
                  to: fixtures.addresses.etherex,
                  amount: amount,
                  market: _.parseInt(txlogs[i].args.market.valueOf()),
                  price: price,
                  total: utils.formatBalance(total),
                  result: 'OK'
                });
            }

            // Get filled trades
            tx_filter = contract.log_fill_tx({
              sender: user.id
            }, {
              fromBlock: 'earliest',
              toBlock: 'latest'
            });
            txlogs = tx_filter.get();
            // console.log("TRANSACTIONS: ", txlogs);
            for (i = txlogs.length - 1; i >= 0; i--) {
                amount = txlogs[i].args.amount.valueOf();
                price = bigRat(txlogs[i].args.price.valueOf()).divide(market.precision).valueOf();
                total = bigRat(amount).divide(Math.pow(10, market.decimals)).multiply(price).multiply(fixtures.ether);

                txs.push({
                  hash: txlogs[i].transactionHash || txlogs[i].hash,
                  type: txlogs[i].args.type.valueOf() == 1 ? 'sell' : 'buy',
                  number: txlogs[i].number,
                  block: txlogs[i].blockNumber,
                  // inout: (_.parseInt(web3.toDecimal(txlogs[i].args.type)) == 1 ? 'in' : 'out'),
                  inout: 'in',
                  from: web3.fromDecimal(txlogs[i].args.sender),
                  to: fixtures.addresses.etherex,
                  amount: amount,
                  market: _.parseInt(txlogs[i].args.market.valueOf()),
                  price: price,
                  total: utils.formatBalance(total),
                  result: 'OK'
                });
              }

            // console.log("TXS: ", txs);

            // Refilter per market...
            txs = _.filter(txs, {market: market.id});

            success(txs);
        }
        catch (e) {
            failure("Unable to load transactions: " + String(e));
        }
    };


    // Balances

    this.updateBalance = function(address, success, failure) {
        var error = "Failed to update balance: ";

        try {
            var hexbalance = web3.eth.getBalance(address);
            // console.log("BALANCE", hexbalance.toString());

            if (!hexbalance || hexbalance == "0x") {
                success(0, false);
                return;
            }
            var balance = web3.toDecimal(hexbalance);
            success(balance, false);
        }
        catch(e) {
            failure(error + String(e));
        }
    };

    this.updateBalanceSub = function(market, address, success, failure) {
        var error = "Failed to update subcurrency balance: ";

        if (!market || !address)
            return;

        try {
            var SubContractABI = web3.eth.contract(fixtures.sub_contract_desc);
            var subcontract = SubContractABI.at(market.address);
            var sub_balance = _.parseInt(subcontract.balance.call(address).toString());

            var balances = contract.get_sub_balance.call(address, market.id);

            var available = balances[0].toString();
            var trading = balances[1].toString();

            if (!available || available == "0")
                available = 0;
            if (!trading || trading == "0")
                trading = 0;

            if (!available && !trading && !sub_balance) {
                success(market, 0, 0, 0);
                return;
            }

            if (available)
                available = bigRat(available).divide(bigRat(String(Math.pow(10, market.decimals)))).valueOf();
            if (trading)
                trading = bigRat(trading).divide(bigRat(String(Math.pow(10, market.decimals)))).valueOf();

            success(market, available, trading, sub_balance);
        }
        catch(e) {
            failure(error + String(e));
        }
    };


    // Ether actions

    this.sendEther = function(user, amount, recipient, success, failure) {
        try {
          var options = {
            from: user.id,
            to: recipient,
            value: amount
          };
          var result = web3.eth.sendTransaction(options);

          success(result);
        }
        catch(e) {
          failure(String(e));
        }
    };

    // Sub actions

    this.sendSub = function(user, amount, recipient, market, success, failure) {
        var SubContractABI = web3.eth.contract(fixtures.sub_contract_desc);
        var subcontract = SubContractABI.at(market.address);

        try {
            var options = {
                from: user.id,
                to: market.address,
                gas: "100000"
            };
            var result = subcontract.transfer.sendTransaction(recipient, amount, options);

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };

    this.depositSub = function(user, amount, market, success, failure) {
        var SubContractABI = web3.eth.contract(fixtures.sub_contract_desc);
        var subcontract = SubContractABI.at(market.address);

        try {
            var options = {
                from: user.id,
                to: market.address,
                gas: "250000"
            };
            var result = subcontract.transfer.sendTransaction(fixtures.addresses.etherex, amount, options);

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };

    this.withdrawSub = function(user, amount, market, success, failure) {
        try {
            var options = {
                from: user.id,
                to: market.address,
                gas: "250000"
            };
            var result = contract.withdraw.sendTransaction(amount, market.id, options);

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };

    this.registerMarket = function(user, market, success, failure) {
        try {
            var options = {
                from: user.id,
                to: fixtures.addresses.etherex,
                gas: "250000"
            };
            var result = contract.add_market.sendTransaction(
                web3.fromAscii(market.name, 32),
                market.address,
                market.decimals,
                market.precision,
                market.minimum,
                market.category,
                options
            );

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };


    // Watches

    this.setUserWatches = function(flux, addresses, markets) {
        // ETH balance
        web3.eth.filter({address: addresses}).watch(flux.actions.user.updateBalance);

        // Sub balances
        var market_addresses = _.pluck(markets, 'address');
        web3.eth.filter({address: market_addresses}).watch(flux.actions.user.updateBalanceSub);
    };

    this.setMarketWatches = function(flux, markets) {
        web3.eth.filter({address: fixtures.addresses.etherex}).watch(flux.actions.market.updateMarkets);
    };


    // Trade actions

    this.addTrade = function(user, trade, market, success, failure) {
        var amounts = this.getAmounts(trade.amount, trade.price, market.decimals, market.precision);

        try {
            var options = {
                from: user.id,
                value: trade.type == 1 ? amounts.total : "0",
                to: fixtures.addresses.etherex,
                gas: "500000"
            };

            var result = false;
            if (trade.type == 1)
                result = contract.buy.sendTransaction(amounts.amount, amounts.price, trade.market, options);
            else if (trade.type == 2)
                result = contract.sell.sendTransaction(amounts.amount, amounts.price, trade.market, options);
            else {
                failure("Invalid trade type.");
                return;
            }

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };

    this.fillTrades = function(user, trades, market, success, failure) {
        // Workaround for lack of array support
        // for (var i = 0; i < trades.length; i++)
        //     this.fillTrade(user, trades[i], market, success, failure);

        var total = bigRat(0);
        var total_amounts = bigRat(0);

        for (var i = trades.length - 1; i >= 0; i--) {
            var amounts = this.getAmounts(trades[i].amount, trades[i].price, market.decimals, market.precision);

            if (trades[i].type == 'sells')
                total += bigRat(amounts.total);

            total_amounts += bigRat(amounts.amount);
        }

        var ids = _.pluck(trades, 'id');

        var gas = ids.length * 100000;

        try {
            var result = contract.trade.sendTransaction(total_amounts, ids, {
                from: user.id,
                gas: String(gas),
                to: fixtures.addresses.etherex,
                value: total > 0 ? total.toString() : "0"
            });

            success(result);
        }
        catch(e) {
            failure(e);
        }
    };

    this.fillTrade = function(user, trade, market, success, failure) {
        var amounts = this.getAmounts(trade.amount, trade.price, market.decimals, market.precision);

        try {
            var result = contract.trade.sendTransaction(amounts.amount, [trade.id], {
                from: user.id,
                gas: "100000",
                to: fixtures.addresses.etherex,
                value: trade.type == "sells" ? amounts.total : "0"
            });

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };

    this.cancelTrade = function(user, trade, success, failure) {
        try {
            var result = contract.cancel.sendTransaction(trade.id, {
                from: user.id,
                value: "0",
                to: fixtures.addresses.etherex,
                gas: "100000"
            });

            success(result);
        }
        catch(e) {
            failure(String(e));
        }
    };


    // Utilities

    this.getAmounts = function(amount, price, decimals, precision) {
        var bigamount = bigRat(amount).multiply(bigRat(Math.pow(10, decimals))).floor(true).toString();
        var bigprice = bigRat(price).multiply(bigRat(precision)).floor(true).toString();
        var total = bigRat(amount)
            .multiply(price)
            .multiply(bigRat(fixtures.ether)).floor(true).toString();
        // console.log("amount: " + bigamount);
        // console.log("price: " + bigprice);
        // console.log("total: " + total);

        return {
            amount: bigamount,
            price: bigprice,
            total: total
        };
    };

    this.formatUnconfirmed = function(confirmed, unconfirmed, fn) {
        unconfirmed = unconfirmed - confirmed;
        if (unconfirmed < 0)
            unconfirmed = "- " + fn(-unconfirmed);
        else
            unconfirmed = fn(unconfirmed);

        return unconfirmed;
    };

    this.getStats = function() {
      return {
        client: web3.version.client,
        gasPrice: web3.eth.gasPrice,
        blockNumber: web3.eth.blockNumber,
        mining: web3.eth.mining,
        hashrate: web3.eth.hashrate,
        peerCount: web3.net.peerCount
      };
    };

};

module.exports = EthereumClient;
