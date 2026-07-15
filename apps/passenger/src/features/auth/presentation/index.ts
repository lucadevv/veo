// Capa de presentación de Auth: onboarding, login por teléfono+OTP, splash y completar perfil.
export {OnboardingScreen} from './screens/OnboardingScreen';
export {AuthScreen} from './screens/AuthScreen';
export {SplashScreen} from './screens/SplashScreen';
export {SessionExpiredScreen} from './screens/SessionExpiredScreen';
export {CompleteProfileScreen} from './screens/CompleteProfileScreen';
export {useAuthFlow, isValidPhone, normalizePhone} from './hooks/useAuthFlow';
export {useOnboardingStore} from './stores/onboardingStore';
export {useProfileLocalStore} from './stores/profileStore';
