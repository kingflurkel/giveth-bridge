
/* eslint-env mocha */
/* eslint-disable no-await-in-loop */
const TestRPC = require('ganache-cli');
const chai = require('chai');
const contracts = require('../build/contracts');
const { LiquidPledging, LPVault, LPFactory, test } = require('giveth-liquidpledging');
const lpContracts = require('giveth-liquidpledging/build/contracts');
const { StandardTokenTest, assertFail } = test;
const { MiniMeToken, MiniMeTokenFactory, MiniMeTokenState } = require('minimetoken');
const Web3 = require('web3');

const assert = chai.assert;

describe('ForeignGivethBridge test', function () {
  this.timeout(0);

  let web3;
  let accounts;
  let factory;
  let bridge;
  let owner;
  let giver1;
  let project1Admin;
  let giverToken;
  let testrpc;
  const mainToken1Address = Web3.utils.toChecksumAddress(Web3.utils.randomHex(20));
  const mainToken2Address = Web3.utils.toChecksumAddress(Web3.utils.randomHex(20));
  let sideToken1;

  before(async () => {
    testrpc = TestRPC.server({
      ws: true,
      gasLimit: 6700000,
      total_accounts: 10,
    });

    testrpc.listen(8545, '127.0.0.1', (err) => { });

    web3 = new Web3('ws://localhost:8545');
    accounts = await web3.eth.getAccounts();

    giver1 = accounts[1];
    project1Admin = accounts[2];
    owner = accounts[3];
  });

  after((done) => {
    testrpc.close();
    done();
  });

  it('Should deploy ForeignGivethBridge contract', async function () {
    const tokenFactory = await MiniMeTokenFactory.new(web3, { gas: 3000000 });

    const baseVault = await LPVault.new(web3, accounts[0]);
    const baseLP = await LiquidPledging.new(web3, accounts[0]);
    const lpFactory = await LPFactory.new(web3, baseVault.$address, baseLP.$address);

    const r = await lpFactory.newLP(accounts[0], accounts[1], { $extraGas: 200000 });

    const vaultAddress = r.events.DeployVault.returnValues.vault;
    vault = new LPVault(web3, vaultAddress);

    const lpAddress = r.events.DeployLiquidPledging.returnValues.liquidPledging;
    liquidPledging = new LiquidPledging(web3, lpAddress);

    // set permissions
    const kernel = new lpContracts.Kernel(web3, await liquidPledging.kernel());
    acl = new lpContracts.ACL(web3, await kernel.acl());
    await acl.createPermission(owner, vault.$address, await vault.CONFIRM_PAYMENT_ROLE(), owner, { $extraGas: 200000 });

    bridge = await contracts.ForeignGivethBridge.new(web3, accounts[0], accounts[0], tokenFactory.$address, liquidPledging.$address, { from: owner, $extraGas: 100000 })

    await liquidPledging.addProject('Project1', '', project1Admin, 0, 0, 0, { from: project1Admin, $extraGas: 100000 });
  });

  it('Only owner should be able to add token', async function () {
    await assertFail(
      bridge.addToken(mainToken1Address, 'Token 1', 18, 'TK1', { from: accounts[0], gas: 6700000 })
    );

    const r = await bridge.addToken(mainToken1Address, 'Token 1', 18, 'TK1', { from: owner, gas: 6700000 });
    const { mainToken, sideToken } = r.events.TokenAdded.returnValues;
    sideToken1 = new MiniMeToken(web3, sideToken);

    assert.equal(mainToken1Address, mainToken);
    assert.equal(sideToken, await bridge.tokenMapping(mainToken));
    assert.equal(mainToken, await bridge.inverseTokenMapping(sideToken));
  })

  it('Only owner should be able to call deposit', async function () {
    const d = liquidPledging.$contract.methods.addGiverAndDonate(1, giver1, sideToken1.$address, 1000).encodeABI();
    await assertFail(
      bridge.deposit(giver1, mainToken1Address, 1000, '0x0000000000000000000000000000000000000000000000000000000000000000', d, { from: giver1, gas: 6700000 })
    )

    const r = await bridge.deposit(giver1, mainToken1Address, 1000, '0x1230000000000000000000000000000000000000000000000000000000000000', d, { from: owner, $extraGas: 100000 });
    const { sender, token, amount, homeTx, data } = r.events.Deposit.returnValues;

    assert.equal(sender, giver1);
    assert.equal(mainToken1Address, token);
    assert.equal(homeTx, '0x1230000000000000000000000000000000000000000000000000000000000000');
    assert.equal(d, data);

    const admin = await liquidPledging.getPledgeAdmin(2);
    assert.equal(giver1, admin.addr);
    assert.equal(0, admin.adminType);

    const bal = await sideToken1.balanceOf(vault.$address);
    assert.equal(1000, bal);
  })

  it('Deposit should fail for missing sideToken', async function () {
    const d = liquidPledging.$contract.methods.addGiverAndDonate(1, giver1, sideToken1.$address, 1000).encodeABI();
    await assertFail(
      bridge.deposit(giver1, mainToken2Address, 1000, '0x0000000000000000000000000000000000000000000000000000000000000000', d, { from: owner, gas: 6700000 })
    )
  })

  it('Should burn tokens on withdrawl', async function () {
    await liquidPledging.withdraw(2, 1000, { from: project1Admin, $extraGas: 100000 });
    await vault.confirmPayment(0, { from: owner, $extraGas: 100000 });

    let bal = await sideToken1.balanceOf(project1Admin);
    let totalSupply = await sideToken1.totalSupply();
    assert.equal(1000, bal);
    assert.equal(1000, totalSupply);

    const r = await bridge.withdraw(sideToken1.$address, 1000, { from: project1Admin, $extraGas: 10000 });
    const { recipient, token, amount } = r.events.Withdraw.returnValues;

    assert.equal(recipient, project1Admin);
    assert.equal(token, mainToken1Address);
    assert.equal(1000, amount);

    bal = await sideToken1.balanceOf(project1Admin);
    totalSupply = await sideToken1.totalSupply();
    assert.equal(0, bal);
    assert.equal(0, totalSupply);
  })
});