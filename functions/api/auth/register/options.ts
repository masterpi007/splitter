import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthEnv, RegisterOptionsRequest } from '../../types/auth';
import { storeChallenge } from '../../utils/challenges';
import { getCredentials } from '../../utils/credentials';
import { getRp } from '../../utils/rp';

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const { memberId, memberName, crossDevice } =
      await context.request.json() as RegisterOptionsRequest & { crossDevice?: boolean };

    if (!memberId || !memberName) {
      return Response.json(
        { success: false, error: 'memberId and memberName are required' },
        { status: 400 }
      );
    }

    const env = context.env;

    // Get existing credentials to exclude them from registration
    const existingCredentials = await getCredentials(env, memberId);

    const { rpID, rpName } = getRp(context.request, env);
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: memberName,
      userID: new TextEncoder().encode(memberId),
      userDisplayName: memberName,
      attestationType: 'none', // We don't need attestation for this app
      excludeCredentials: existingCredentials.map(cred => ({
        id: cred.id,
        transports: cred.transports,
      })),
      authenticatorSelection: {
        // Default to the device's own biometrics: without an attachment the
        // browser shows the whole transport picker and some Android builds
        // never surface the fingerprint at all.
        //
        // But 'platform' is a hard filter, and a device with no screen lock,
        // no Google account or no biometric hardware then has no way in. When
        // the client reports it found no platform authenticator we drop the
        // filter so the QR / another-device route reappears.
        ...(crossDevice
          ? { authenticatorAttachment: 'cross-platform' as const }
          : { authenticatorAttachment: 'platform' as const }),
        residentKey: 'required', // Required for discoverable credentials
        userVerification: 'preferred',
      },
      hints: crossDevice ? ['hybrid'] : ['client-device'],
    });

    // Store challenge for verification
    await storeChallenge(env, memberId, options.challenge, 'registration');

    return Response.json({
      success: true,
      data: { options },
    });
  } catch (error) {
    console.error('Registration options error:', error);
    return Response.json(
      { success: false, error: 'Failed to generate registration options' },
      { status: 500 }
    );
  }
};
