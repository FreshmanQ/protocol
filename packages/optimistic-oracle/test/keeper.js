const winston = require("winston");

const { toWei, hexToUtf8, utf8ToHex } = web3.utils;

const { OptimisticOracleClient } = require("../../financial-templates-lib/src/clients/OptimisticOracleClient");
const { GasEstimator } = require("../../financial-templates-lib/src/helpers/GasEstimator");
const { OptimisticOracleKeeper } = require("../src/keeper");
const { interfaceName } = require("@uma/common");
const { getTruffleContract } = require("@uma/core");

const CONTRACT_VERSION = "latest";

const OptimisticOracle = getTruffleContract("OptimisticOracle", web3, CONTRACT_VERSION);
const OptimisticRequesterTest = getTruffleContract("OptimisticRequesterTest", web3, CONTRACT_VERSION);
const Finder = getTruffleContract("Finder", web3, CONTRACT_VERSION);
const IdentifierWhitelist = getTruffleContract("IdentifierWhitelist", web3, CONTRACT_VERSION);
const Token = getTruffleContract("ExpandedERC20", web3, CONTRACT_VERSION);
const AddressWhitelist = getTruffleContract("AddressWhitelist", web3, CONTRACT_VERSION);
const Timer = getTruffleContract("Timer", web3, CONTRACT_VERSION);
const Store = getTruffleContract("Store", web3, CONTRACT_VERSION);
const MockOracle = getTruffleContract("MockOracleAncillary", web3, CONTRACT_VERSION);

contract("OptimisticOracle: keeper.js", function(accounts) {
  const owner = accounts[0];
  const requester = accounts[1];
  const proposer = accounts[2];
  const disputer = accounts[3];
  const rando = accounts[4];
  const botRunner = accounts[5];

  // Contracts
  let optimisticRequester;
  let optimisticOracle;
  let finder;
  let timer;
  let identifierWhitelist;
  let collateralWhitelist;
  let store;
  let collateral;

  // Offchain infra
  let client;
  let gasEstimator;
  let keeper;
  let dummyLogger;
  let mockOracle;

  // Timestamps that we'll use throughout the test.
  let requestTime;
  let startTime;

  // Default testing values.
  const liveness = 7200; // 2 hours
  const initialUserBalance = toWei("100");
  const finalFee = toWei("1");
  const totalDefaultBond = toWei("2"); // 2x final fee
  const correctPrice = toWei("-17");

  // These identifiers are special test ones that are mapped to certain `priceFeedDecimal`
  // configurations used to construct pricefeeds. For example, "TEST8DECIMALS" will construct
  // a pricefeed that returns prices in 8 decimals. This is useful for testing that a bot is
  // constructing the right type of pricefeed by default. This mapping is stored in @uma/common/PriceIdentifierUtils.js
  const identifier = web3.utils.utf8ToHex("TEST8DECIMALS");

  const identifiersToTest = [
    web3.utils.utf8ToHex("TEST8DECIMALS"),
    web3.utils.utf8ToHex("TEST6DECIMALS"),
    web3.utils.utf8ToHex("TEST18DECIMALS")
  ];

  const pushPrice = async price => {
    const [lastQuery] = (await mockOracle.getPendingQueries()).slice(-1);
    await mockOracle.pushPrice(lastQuery.identifier, lastQuery.time, lastQuery.ancillaryData, price);
  };

  before(async function() {
    finder = await Finder.new();
    timer = await Timer.new();

    // Whitelist test identifiers we can use to make default price requests.
    identifierWhitelist = await IdentifierWhitelist.new();
    identifiersToTest.forEach(async identifier => {
      await identifierWhitelist.addSupportedIdentifier(identifier);
    });
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.IdentifierWhitelist), identifierWhitelist.address);

    collateralWhitelist = await AddressWhitelist.new();
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.CollateralWhitelist), collateralWhitelist.address);

    store = await Store.new({ rawValue: "0" }, { rawValue: "0" }, timer.address);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Store), store.address);

    mockOracle = await MockOracle.new(finder.address, timer.address);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Oracle), mockOracle.address);
  });

  beforeEach(async function() {
    // Deploy and whitelist a new collateral currency that we will use to pay oracle fees.
    collateral = await Token.new("Wrapped Ether", "WETH", 18);
    await collateral.addMember(1, owner);
    await collateral.mint(owner, initialUserBalance);
    await collateral.mint(proposer, initialUserBalance);
    await collateral.mint(requester, initialUserBalance);
    await collateral.mint(disputer, initialUserBalance);
    await collateralWhitelist.addToWhitelist(collateral.address);

    // Set a non-0 final fee for the collateral currency.
    await store.setFinalFee(collateral.address, { rawValue: finalFee });

    optimisticOracle = await OptimisticOracle.new(liveness, finder.address, timer.address);

    // Contract used to make price requests
    optimisticRequester = await OptimisticRequesterTest.new(optimisticOracle.address);

    startTime = (await optimisticOracle.getCurrentTime()).toNumber();
    requestTime = startTime - 10;

    // The ExpiringMultiPartyClient does not emit any info `level` events.  Therefore no need to test Winston outputs.
    // DummyLogger will not print anything to console as only capture `info` level events.
    dummyLogger = winston.createLogger({
      level: "info",
      transports: [new winston.transports.Console()]
    });

    client = new OptimisticOracleClient(
      dummyLogger,
      OptimisticOracle.abi,
      MockOracle.abi,
      web3,
      optimisticOracle.address,
      mockOracle.address
    );

    gasEstimator = new GasEstimator(dummyLogger);

    let defaultPriceFeedConfig = {
      lookback: 100, // Request time is 10 secs behind now, so 100 lookback will cover it.
      currentPrice: "1", // Mocked current price. This will be scaled to the identifier's precision.
      historicalPrice: "2" // Mocked historical price. This will be scaled to the identifier's precision.
    };
    keeper = new OptimisticOracleKeeper({
      logger: dummyLogger,
      optimisticOracleClient: client,
      gasEstimator,
      account: botRunner,
      defaultPriceFeedConfig
    });

    // Make a new price request for each identifier, each of which should cause the keeper bot to
    // construct a pricefeed with a new precision.
    identifiersToTest.forEach(async identifier => {
      await optimisticRequester.requestPrice(identifier, requestTime, "0x", collateral.address, 0);
    });
  });

  it("Can send proposals to new price requests", async function() {
    await keeper.update();
    let result = client.getUndisputedProposals();
    assert.deepStrictEqual(result, []);
    result = client.getSettleableProposals(proposer);
    assert.deepStrictEqual(result, []);

    // Should have one price request for each identifier.
    let expectedResults = [];
    identifiersToTest.forEach(identifier => {
      expectedResults.push({
        requester: optimisticRequester.address,
        identifier: hexToUtf8(identifier),
        timestamp: requestTime.toString(),
        currency: collateral.address,
        reward: "0",
        finalFee
      });
    });
    result = client.getUnproposedPriceRequests();
    assert.deepStrictEqual(result, expectedResults);

    // Now: Execute `sendProposals()` and test that the bot correctly responds to these price proposals
    await keeper.sendProposals();
  });

  it("Can send disputes to proposals", async function() {
    await keeper.update();
    let result = client.getSettleableDisputes(disputer);
    assert.deepStrictEqual(result, []);

    // Make a proposal:
    await collateral.approve(optimisticOracle.address, totalDefaultBond, { from: proposer });
    await optimisticOracle.proposePrice(optimisticRequester.address, identifier, requestTime, "0x", correctPrice, {
      from: proposer
    });

    await client.update();
    result = client.getSettleableDisputes(disputer);
    assert.deepStrictEqual(result, []);

    // Now: Execute `sendDisputes()` and test that the bot correctly respodns to these price proposals

    // Dispute the proposal:
    await collateral.approve(optimisticOracle.address, totalDefaultBond, { from: disputer });
    await optimisticOracle.disputePrice(optimisticRequester.address, identifier, requestTime, "0x", { from: disputer });
    result = client.getSettleableDisputes(disputer);
    assert.deepStrictEqual(result, []);

    // Resolve the dispute and check that the client detects the new state:
    await pushPrice(correctPrice);
    await client.update();
    // Note: `getSettleableDisputes` only returns proposals where the `disputer` is involved
    result = client.getSettleableDisputes(rando);
    assert.deepStrictEqual(result, []);
    result = client.getSettleableDisputes(disputer);
    assert.deepStrictEqual(result, [
      {
        requester: optimisticRequester.address,
        proposer: proposer,
        disputer: disputer,
        identifier: hexToUtf8(identifier),
        timestamp: requestTime.toString()
      }
    ]);

    // Settle the dispute and make sure that the client no longer sees it as settleable:
    await optimisticOracle.settle(optimisticRequester.address, identifier, requestTime, "0x");
    await client.update();
    result = client.getSettleableDisputes(disputer);
    assert.deepStrictEqual(result, []);
  });

  // Can settle requests
});