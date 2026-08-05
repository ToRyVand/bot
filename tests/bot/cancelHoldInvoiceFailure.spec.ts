export {};

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Issue #899: when cancelHoldInvoice fails (e.g. LND unreachable) a cancel flow
// must NOT proceed as if the order was canceled, and it must tell the user so
// they can retry — instead of silently swallowing the failure.

const releaseTakeSlot = sinon.stub().resolves();

const BUYER = { _id: 'buyer1', tg_id: '111' };
const SELLER = { _id: 'seller1', tg_id: '222' };

// Trackable stub for the user-feedback message so we can assert it fired.
const cancelHoldInvoiceErrorMessage = sinon.stub().resolves();
const messagesMock: any = new Proxy(
  { __esModule: true },
  {
    get: (_t, k) => {
      if (k === '__esModule') return true;
      if (k === 'cancelHoldInvoiceErrorMessage')
        return cancelHoldInvoiceErrorMessage;
      return sinon.stub().resolves();
    },
  },
);

const modelsMock = {
  Order: {},
  User: {
    findOne: sinon.stub().callsFake(async ({ _id }: any) => {
      if (_id === BUYER._id) return BUYER;
      if (_id === SELLER._id) return SELLER;
      return null;
    }),
  },
  Dispute: {},
  '@noCallThru': true,
};

// cancelHoldInvoice rejects to simulate LND being down.
const lnMock = {
  createHoldInvoice: sinon.stub().resolves(),
  subscribeInvoice: sinon.stub().resolves(),
  cancelHoldInvoice: sinon.stub().rejects(new Error('LND unreachable')),
  settleHoldInvoice: sinon.stub().resolves(),
  getInvoice: sinon.stub().resolves(),
  '@noCallThru': true,
};

const utilMock = {
  getBtcFiatPrice: sinon.stub().resolves(),
  deleteOrderFromChannel: sinon.stub().resolves(),
  getUserI18nContext: sinon.stub().resolves({ t: (k: string) => k }),
  getFee: sinon.stub().resolves(0),
  removeLightningPrefix: sinon.stub(),
  PerOrderIdMutex: {
    instance: { runExclusive: async (_: any, cb: any) => cb() },
  },
  '@noCallThru': true,
};

const nsMock = () =>
  new Proxy(
    { __esModule: true },
    { get: (_t, k) => (k === '__esModule' ? true : sinon.stub().resolves()) },
  );

const { cancelShowHoldInvoice, cancelAddInvoice } = proxyquire(
  '../../bot/commands',
  {
    '../ln': lnMock,
    '../models': modelsMock,
    './messages': messagesMock,
    '../util': utilMock,
    './modules/orders/takeOrder': { releaseTakeSlot, '@noCallThru': true },
    '../lnurl/lnurl-pay': {
      resolvLightningAddress: sinon.stub(),
      '@noCallThru': true,
    },
    './modules/events/orders': nsMock(),
    './ordersActions': nsMock(),
    './validations': nsMock(),
  },
);

describe('cancelHoldInvoice failure notifies the user and aborts (#899)', () => {
  const job = {};

  beforeEach(() => {
    releaseTakeSlot.resetHistory();
    cancelHoldInvoiceErrorMessage.resetHistory();
    lnMock.cancelHoldInvoice.resetHistory();
  });

  const makeOrder = () => ({
    _id: 'o1',
    type: 'sell',
    status: 'WAITING_PAYMENT',
    hash: 'somehash',
    buyer_id: BUYER._id,
    seller_id: SELLER._id,
    creator_id: SELLER._id,
    save: sinon.stub().resolves(),
  });

  it('cancelShowHoldInvoice: tells the user and does not cancel the order', async () => {
    const order: any = makeOrder();

    await cancelShowHoldInvoice({} as any, order, job);

    expect(lnMock.cancelHoldInvoice.calledOnce).to.equal(true);
    // User is notified so they can retry
    expect(cancelHoldInvoiceErrorMessage.calledOnce).to.equal(true);
    // Flow aborted: order not closed, not saved, take slot not released
    expect(order.status).to.equal('WAITING_PAYMENT');
    expect(order.save.called).to.equal(false);
    expect(releaseTakeSlot.called).to.equal(false);
  });

  it('cancelAddInvoice: tells the user and does not cancel the order', async () => {
    const order: any = makeOrder();

    await cancelAddInvoice({} as any, order, job);

    expect(lnMock.cancelHoldInvoice.calledOnce).to.equal(true);
    expect(cancelHoldInvoiceErrorMessage.calledOnce).to.equal(true);
    expect(order.status).to.equal('WAITING_PAYMENT');
    expect(order.save.called).to.equal(false);
  });
});

// The same cancel helpers also run from the expiry job with `bot` (or null) in
// place of a real Telegram context. The message helper must no-op there instead
// of crashing on a missing `reply`/`i18n` (issue #899).
describe('cancelHoldInvoiceErrorMessage is safe without an interactive context', () => {
  const realMessages = require('../../bot/messages');

  it('no-ops for null, an empty object, or a bot-like object (no reply)', async () => {
    await realMessages.cancelHoldInvoiceErrorMessage(null);
    await realMessages.cancelHoldInvoiceErrorMessage({});
    await realMessages.cancelHoldInvoiceErrorMessage({ telegram: {} });
    // Reaching here without throwing is the assertion.
  });

  it('replies with the generic error when the context is interactive', async () => {
    const reply = sinon.stub().resolves();
    const ctx = { reply, i18n: { t: (k: string) => k } };
    await realMessages.cancelHoldInvoiceErrorMessage(ctx);
    expect(reply.calledOnceWithExactly('generic_error')).to.equal(true);
  });
});
