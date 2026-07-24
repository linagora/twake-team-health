import { describe, it, expect } from 'vitest';
import { memberWindow, MEMBER_MONTHS_CAP } from './selection';

describe('memberWindow', () => {
	const FLOOR = 3;

	it('follows the selected period', () => {
		expect(memberWindow(6, FLOOR)).toBe(6);
		expect(memberWindow(12, FLOOR)).toBe(12);
	});

	it('caps a long period so the heaviest fetches stay bounded', () => {
		expect(memberWindow(24, FLOOR)).toBe(MEMBER_MONTHS_CAP);
	});

	it('never exceeds the period, so the label cannot overclaim', () => {
		// Below the floor: the data only covers 2 months, so the window must say 2.
		expect(memberWindow(2, FLOOR)).toBe(2);
		expect(memberWindow(1, FLOOR)).toBe(1);
	});

	it('keeps a configured floor that sits above the cap', () => {
		// A deployment that deliberately set 18 keeps it rather than being cut to 12.
		expect(memberWindow(24, 18)).toBe(18);
	});
});
