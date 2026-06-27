import { describe, it, expect } from 'vitest';
import { bearerAuthorized } from './cron-auth';

describe('bearerAuthorized', () => {
	it('rejects when no secret is configured (disabled by default)', () => {
		expect(bearerAuthorized('Bearer anything', undefined)).toBe(false);
		expect(bearerAuthorized('Bearer anything', '')).toBe(false);
	});

	it('rejects a missing or wrong header', () => {
		expect(bearerAuthorized(null, 's3cret')).toBe(false);
		expect(bearerAuthorized('Bearer nope', 's3cret')).toBe(false);
		expect(bearerAuthorized('s3cret', 's3cret')).toBe(false); // missing "Bearer " prefix
	});

	it('accepts the exact bearer secret', () => {
		expect(bearerAuthorized('Bearer s3cret', 's3cret')).toBe(true);
	});
});
