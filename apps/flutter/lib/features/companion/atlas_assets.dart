const atlasStates = {
  'available',
  'listening',
  'responding',
  'working',
  'needs_you',
  'blocked',
  'completed',
  'paused',
};

/// Intensity only changes decorative delivery. Verified reaction identity,
/// visibility, reduced motion and asset admission still gate actual playback.
bool atlasMotionAllowed(String? intensity, String state) {
  if (intensity != 'balanced' && intensity != 'expressive') return false;
  if (state == 'completed') return true;
  return intensity == 'expressive' &&
      (state == 'listening' || state == 'responding' || state == 'working');
}
