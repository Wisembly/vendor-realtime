const webpack        = require('webpack');
const { resolve }    = require('path');
const packageJson    = require('./package.json');

const UglifyJSPlugin = require('uglifyjs-webpack-plugin');

module.exports = {
  entry: {
    'realtime': './src/realtime.js',
    'realtime.min': './src/realtime.js'
  },

  output: {
    filename: '[name].js',
    path: resolve(__dirname, 'dist'),
    library: 'WisemblyRealTime',
    libraryTarget: 'umd'
  },

  externals: [
    'socket.io-client'
  ],

  module: {
    rules: [
      {
        test: /.js$/,
        exclude: /(node_modules|bower_components)/,
        loader: 'babel-loader',
        query: {
          presets: ['stage-0', 'es2015'],
          plugins: ['transform-runtime']
        }
      }
    ]
  },

  plugins: [
    new webpack.DefinePlugin({
      '__VERSION__': JSON.stringify(packageJson.version)
    }),

    new UglifyJSPlugin({
      test: /\.min.js$/
    })
  ]
}
