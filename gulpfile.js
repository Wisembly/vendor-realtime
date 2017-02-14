var gulp = require('gulp'),
    uglify = require('gulp-uglify'),
    rename = require('gulp-rename'),
    babel = require('gulp-babel');

gulp.task('default', function () {
    gulp.start('scripts');
});

gulp.task('scripts', function () {
    return gulp.src('src/realtime.js')
        .pipe(babel({
            plugins: ['es6-promise'],
            presets: ['stage-0', 'es2015']
        }))
        .pipe(gulp.dest('dist'))
        .pipe(rename({ suffix: '.min' }))
        .pipe(uglify())
        .pipe(gulp.dest('dist'));
});
