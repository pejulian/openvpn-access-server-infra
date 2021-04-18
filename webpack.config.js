const path = require('path');
const { readdirSync } = require('fs');

const dir = 'src';
const entry = readdirSync(dir)
    .filter((item) => /\.(t|j)s$/.test(item))
    .filter((item) => !/\.d\.(t|j)s$/.test(item))
    .reduce(
        (acc, fileName) => ({
            ...acc,
            [fileName.replace(/\.(t|j)s$/, '')]: `./${dir}/${fileName}`,
        }),
        {}
    );

module.exports = {
    entry,
    mode: 'development',
    target: 'node',
    devtool: 'inline-source-map',
    externals: [/^aws-sdk(\/.+)?$/],
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: 'tsconfig.src.json',
                        },
                    },
                ],
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        modules: ['node_modules'],
        extensions: ['.tsx', '.ts', '.js', '.json'],
    },
    output: {
        libraryTarget: 'commonjs2',
        path: path.join(__dirname, 'dist'),
        filename: '[name].js',
    },
};
