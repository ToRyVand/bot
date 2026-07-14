export {};

const { expect } = require('chai');
const sinon = require('sinon');

/**
 * Locks in the fix for issue #595: sometimes the fiat-sent messages were not
 * delivered.
 *
 * Root cause: fiatSentMessages sent its three messages sequentially inside a
 * single try/catch. If the first send failed (e.g. the buyer blocked the bot),
 * the remaining sends were skipped and the error swallowed — with the order
 * already in FIAT_SENT, the seller never learned the fiat was on its way nor
 * how to release. Each notification must be attempted independently.
 */

const messages = require('../../bot/messages');

const BUYER: any = { tg_id: '100', username: 'buyer' };
const SELLER: any = { tg_id: '200', username: 'seller' };
const i18n: any = { t: (key: string) => key };

const makeCtx = (sendMessage: any) => ({ telegram: { sendMessage } }) as any;

describe('fiatSentMessages (issue #595)', () => {
  it('notifies the seller even when the buyer is unreachable', async () => {
    const sendMessage = sinon.stub().resolves();
    sendMessage.withArgs(BUYER.tg_id).rejects(new Error('bot was blocked'));

    await messages.fiatSentMessages(
      makeCtx(sendMessage),
      BUYER,
      SELLER,
      i18n,
      i18n,
    );

    const sellerCalls = sendMessage
      .getCalls()
      .filter((c: any) => c.args[0] === SELLER.tg_id);
    expect(sellerCalls).to.have.length(2);
    expect(sellerCalls[0].args[1]).to.equal('buyer_told_me_that_sent_fiat');
    expect(sellerCalls[1].args[1]).to.equal('release_order_cmd');
  });

  it('notifies the buyer even when the seller is unreachable', async () => {
    const sendMessage = sinon.stub().resolves();
    sendMessage.withArgs(SELLER.tg_id).rejects(new Error('bot was blocked'));

    await messages.fiatSentMessages(
      makeCtx(sendMessage),
      BUYER,
      SELLER,
      i18n,
      i18n,
    );

    const buyerCalls = sendMessage
      .getCalls()
      .filter((c: any) => c.args[0] === BUYER.tg_id);
    expect(buyerCalls).to.have.length(1);
    expect(buyerCalls[0].args[1]).to.equal('I_told_seller_you_sent_fiat');
  });

  it('sends all three messages in order on the happy path', async () => {
    const sendMessage = sinon.stub().resolves();

    await messages.fiatSentMessages(
      makeCtx(sendMessage),
      BUYER,
      SELLER,
      i18n,
      i18n,
    );

    expect(sendMessage.callCount).to.equal(3);
    expect(sendMessage.getCall(0).args[0]).to.equal(BUYER.tg_id);
    expect(sendMessage.getCall(1).args[0]).to.equal(SELLER.tg_id);
    expect(sendMessage.getCall(2).args[0]).to.equal(SELLER.tg_id);
  });

  it('does not throw even if every send fails', async () => {
    const sendMessage = sinon.stub().rejects(new Error('network down'));

    await messages.fiatSentMessages(
      makeCtx(sendMessage),
      BUYER,
      SELLER,
      i18n,
      i18n,
    );

    expect(sendMessage.callCount).to.equal(3);
  });
});
