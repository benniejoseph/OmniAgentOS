/** Fit a sphere against both perspective frustum planes, including its depth. */
export function universeSphereFitDistance(
  radius: number,
  verticalFovDegrees: number,
  aspect: number,
) {
  const verticalHalfFov = verticalFovDegrees * Math.PI / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  // The tangent plane touches a sphere at r / sin(half-FOV), not r / tan(...).
  // Padding leaves room for the screen-space point markers around its surface.
  return radius * 1.12 / Math.sin(limitingHalfFov);
}
