module.exports = {
    roots: ['<rootDir>/test'],
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
    },
    collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}'],
    modulePathIgnorePatterns: [
        '<rootDir>/dist',
        '<rootDir>/cdk.out',
        '<rootDir>/coverage',
        '<rootDir>/bin',
    ],
};
