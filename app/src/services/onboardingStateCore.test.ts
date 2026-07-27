import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldOpenOnboarding, shouldShowCoach } from './onboardingStateCore';

test('已有 token 但 /me 尚未回读时不能抢跑首次入局', () => {
  assert.equal(shouldOpenOnboarding({
    authed: true,
    onboardingKnown: false,
    onboarded: false,
  }), false);
});

test('服务端明确未建档后才进入首次入局', () => {
  assert.equal(shouldOpenOnboarding({
    authed: true,
    onboardingKnown: true,
    onboarded: false,
  }), true);
});

test('Tab 功能引导只对刚完成入局、已显式 armed 的账号展示', () => {
  assert.equal(shouldShowCoach({ authed: true, onboarded: true, armed: false, done: false }), false);
  assert.equal(shouldShowCoach({ authed: true, onboarded: true, armed: true, done: false }), true);
  assert.equal(shouldShowCoach({ authed: true, onboarded: true, armed: true, done: true }), false);
});
