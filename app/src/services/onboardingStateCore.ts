export function shouldOpenOnboarding(input: {
  authed: boolean;
  onboardingKnown: boolean;
  onboarded: boolean;
}): boolean {
  return input.authed && input.onboardingKnown && !input.onboarded;
}

export function shouldShowCoach(input: {
  authed: boolean;
  onboarded: boolean;
  armed: boolean;
  done: boolean;
}): boolean {
  return input.authed && input.onboarded && input.armed && !input.done;
}
